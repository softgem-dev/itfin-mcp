import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { logEntry, me, reopenRequest, trackingRoute, workspace, type DayOverrides } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

const TODAY = "2026-09-24";

async function loggedIn(days: Record<string, DayOverrides> = {}, reopen: unknown[] = []) {
  h = await startHarness({ now: "2026-09-24T09:00:00Z" });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  const host = new URL(h.itfin.url).host;
  h.itfin
    .on("GET /api/v1/tracking", trackingRoute({ today: TODAY, days }))
    .on("GET /api/v1/auth", { body: me })
    .on(`GET /api/v1/auth/workspaces/${host}`, { body: workspace })
    .on("GET /api/v1/requests/my", { body: reopen })
    .on("POST /api/v1/tracking", { body: { Id: 900 } });
  return h;
}

const validEntry = { date: TODAY, clientAgreementId: 5001, minutes: 90, comment: "Reviewed pull requests" };

describe("itfin_create_entry", () => {
  it("creates a time entry on an open day for the logged-in employee", async () => {
    await loggedIn();
    const res = await h.call("itfin_create_entry", { ...validEntry, taskId: 71 });

    expect(res).toEqual({ isError: false, data: { id: 900 } });
    const [post] = h.itfin.writes();
    expect(post).toMatchObject({ method: "POST", path: "/api/v1/tracking" });
    expect(post!.body).toMatchObject({
      EmployeeId: 1001,
      Date: TODAY,
      ClientAgreementId: 5001,
      TaskId: 71,
      MinutesInt: 90,
      InternalTime: "1.5",
      Comment: "Reviewed pull requests",
      IsNonBillable: false,
    });
    expect(post!.body).not.toHaveProperty("ExternalTool");
  });

  it("rejects a comment shorter than the workspace minimum without calling ITFin", async () => {
    await loggedIn();
    const res = await h.call("itfin_create_entry", { ...validEntry, comment: "fix" });
    expect(res.data.error).toMatchObject({ code: "VALIDATION", minCommentLength: 10 });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("rejects a closed day with DAY_CLOSED, the reopen request status and a hint", async () => {
    await loggedIn({}, [reopenRequest({ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" })]);
    const res = await h.call("itfin_create_entry", { ...validEntry, date: "2026-09-18" });

    expect(res.data.error).toMatchObject({
      code: "DAY_CLOSED",
      closedDates: ["2026-09-18"],
      reopenRequests: [{ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" }],
    });
    expect(res.data.error.hint).toMatch(/itfin_request_reopen/);
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("writes to a closed day covered by an approved reopen request", async () => {
    await loggedIn({}, [reopenRequest({ id: 8, from: "2026-09-14", to: "2026-09-20", status: "Approved" })]);
    const res = await h.call("itfin_create_entry", { ...validEntry, date: "2026-09-18" });
    expect(res.isError).toBe(false);
    expect(h.itfin.writes()).toHaveLength(1);
  });

  it("maps ITFin's 'Tracking is not allowed for this day.' to DAY_CLOSED", async () => {
    await loggedIn();
    h.itfin.on("POST /api/v1/tracking", { status: 400, body: { message: "Tracking is not allowed for this day." } });
    const res = await h.call("itfin_create_entry", validEntry);
    expect(res.data.error).toMatchObject({ code: "DAY_CLOSED", closedDates: [TODAY] });
  });

  it("reports a future day as DAY_IN_FUTURE, not DAY_CLOSED", async () => {
    await loggedIn();
    const res = await h.call("itfin_create_entry", { ...validEntry, date: "2026-09-25" });
    expect(res.data.error.code).toBe("DAY_IN_FUTURE");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

describe("itfin_update_entry", () => {
  const existing = logEntry({ id: 42, date: "2026-09-22", minutes: 480, comment: "Releasing identity changes", taskId: 71 });

  it("sends the whole entry with only the given fields changed", async () => {
    await loggedIn({ "2026-09-22": { log: [existing] } });
    h.itfin.on("PUT /api/v1/tracking/42", { body: { Id: 42 } });

    const res = await h.call("itfin_update_entry", { id: 42, date: "2026-09-22", minutes: 240 });

    expect(res).toEqual({ isError: false, data: { id: 42 } });
    const [put] = h.itfin.writes();
    expect(put).toMatchObject({ method: "PUT", path: "/api/v1/tracking/42" });
    expect(put!.body).toMatchObject({
      Id: 42,
      Date: "2026-09-22",
      ClientAgreementId: 5001,
      TaskId: 71,
      Comment: "Releasing identity changes",
      MinutesInt: 240,
      InternalTime: "4",
      IsNonBillable: false,
    });
    expect(put!.body).not.toHaveProperty("ExternalTool");
  });

  it("fails with NOT_FOUND when the entry is not on the given date", async () => {
    await loggedIn({ "2026-09-22": { log: [existing] } });
    const res = await h.call("itfin_update_entry", { id: 43, date: "2026-09-22", minutes: 60 });
    expect(res.data.error.code).toBe("NOT_FOUND");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("refuses to move an entry to a closed day", async () => {
    await loggedIn({ "2026-09-22": { log: [existing] } });
    const res = await h.call("itfin_update_entry", { id: 42, date: "2026-09-22", newDate: "2026-09-18" });
    expect(res.data.error).toMatchObject({ code: "DAY_CLOSED", closedDates: ["2026-09-18"] });
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

describe("itfin_delete_entry", () => {
  it("deletes a time entry on an open day", async () => {
    await loggedIn({ "2026-09-22": { log: [logEntry({ id: 42, date: "2026-09-22", minutes: 60, comment: "Standup and planning" })] } });
    h.itfin.on("DELETE /api/v1/tracking/42", { status: 204 });
    const res = await h.call("itfin_delete_entry", { id: 42, date: "2026-09-22" });
    expect(res).toEqual({ isError: false, data: { deleted: 42 } });
    expect(h.itfin.writes()).toMatchObject([{ method: "DELETE", path: "/api/v1/tracking/42" }]);
  });

  it("refuses to delete on a closed day", async () => {
    await loggedIn({ "2026-09-18": { log: [logEntry({ id: 41, date: "2026-09-18", minutes: 60, comment: "Standup and planning" })] } });
    const res = await h.call("itfin_delete_entry", { id: 41, date: "2026-09-18" });
    expect(res.data.error.code).toBe("DAY_CLOSED");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});
