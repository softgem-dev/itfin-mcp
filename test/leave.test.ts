import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { leaveRequest, leaveRequestInfo, leaveTypes, me, reopenRequest, workspace } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

async function loggedIn(opts: { elicitation?: boolean; settings?: unknown; info?: unknown } = {}) {
  h = await startHarness({ now: "2026-09-24T09:00:00Z", elicitation: opts.elicitation });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  h.itfin
    .on("GET /api/v1/auth", { body: me })
    .on(`GET /api/v1/auth/workspaces/${new URL(h.itfin.url).host}`, { body: opts.settings ?? workspace })
    .on("GET /api/v3/timeoff-types/available/2026-09-24/1001", { body: leaveTypes })
    .on("POST /api/v3/timeoff/request-info", { body: opts.info ?? leaveRequestInfo() })
    .on("POST /api/v2/requests/timeoff", { body: { Id: 77 } });
  return h;
}

const vacation = { leaveTypeId: 11, from: "2026-10-01", to: "2026-10-02", reason: "Rest and relax", comment: "Vacation" };
const filedBody = {
  EmployeeId: 1001,
  TimeoffTypeId: 11,
  TimeoffType: "Vacation",
  Date: null,
  DateFrom: "2026-10-01",
  DateTo: "2026-10-02",
  IsPartDay: false,
  Reason: "Rest and relax",
  Comment: "Vacation",
};
const filings = () => h.itfin.writes().filter((r) => r.path === "/api/v2/requests/timeoff");

describe("itfin_list_leave_types", () => {
  it("lists requestable leave types with their reasons, without carry-over days", async () => {
    await loggedIn();
    const res = await h.call("itfin_list_leave_types");
    expect(res.data.leaveTypes.map((t: { id: number }) => t.id)).toEqual([11, 12, 13]);
    expect(res.data.leaveTypes[1]).toMatchObject({ name: "Sick leave", requestType: "Sickness", paid: true, reasonRequired: true });
    expect(res.data.leaveTypes[1].reasons).toContain("Other");
    expect(res.data.leaveTypes[2]).toMatchObject({ paid: false, reasons: [], reasonRequired: false });
  });

  it("adds the workspace's extra reasons, or replaces the built-in ones after a '-' line", async () => {
    await loggedIn({ settings: { Settings: { ...workspace.Settings, AdditionalVacationLeaveReasons: "Hiking\nFamily trip", AdditionalSicknessReasons: "-\nIll", TimeoffIsReasonOptional: true } } });
    const [vac, sick] = (await h.call("itfin_list_leave_types")).data.leaveTypes;
    expect(vac.reasons.slice(-2)).toEqual(["Hiking", "Family trip"]);
    expect(vac.reasonRequired).toBe(false);
    expect(sick.reasons).toEqual(["Ill"]);
  });
});

describe("itfin_list_leave_requests", () => {
  it("lists only leave requests, with dates as YYYY-MM-DD", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", {
      body: [leaveRequest({ id: 5, type: "Vacation", from: "2026-10-01", to: "2026-10-02", status: "Pending" }), reopenRequest({ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" })],
    });
    const res = await h.call("itfin_list_leave_requests", { from: "2026-10-01", to: "2026-10-31" });
    expect(res.data.requests).toEqual([
      { id: 5, type: "Vacation", from: "2026-10-01", to: "2026-10-02", status: "Pending", reason: "Rest and relax", comment: "Vacation", createdAt: "2026-09-01T08:00:00.000Z" },
    ]);
    expect(h.itfin.requests.at(-1)!.query).toMatchObject({ "filter[from]": "2026-10-01", "filter[to]": "2026-10-31" });
  });
});

describe("itfin_request_leave with a confirmation form", () => {
  it("checks the request with ITFin and files it when the user accepts", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", vacation);
    expect(res).toEqual({ isError: false, data: { requested: true, id: 77 } });
    expect(h.itfin.writes()).toMatchObject([
      { path: "/api/v3/timeoff/request-info", body: { employeeId: 1001, timeoffId: 11, dateFrom: "2026-10-01", dateTo: "2026-10-02", isPartDay: false } },
      { path: "/api/v2/requests/timeoff", body: filedBody },
    ]);
  });

  it("files nothing when the user declines", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "decline" };
    const res = await h.call("itfin_request_leave", vacation);
    expect(res.data.error.code).toBe("CONFIRMATION_DECLINED");
    expect(res.data.error.message).toContain("leave request");
    expect(filings()).toHaveLength(0);
  });
});

describe("itfin_request_leave confirmed in chat", () => {
  it("returns a preview with the counted days and files it with the confirmation token", async () => {
    await loggedIn({ elicitation: false });
    const { data } = await h.call("itfin_request_leave", vacation);
    expect(data).toMatchObject({
      requested: false,
      needsUserConfirmation: true,
      preview: { leaveType: "Vacation", from: "2026-10-01", to: "2026-10-02", reason: "Rest and relax", comment: "Vacation", requestedDays: 2, availableDays: 18 },
    });
    expect(filings()).toHaveLength(0);
    const res = await h.call("itfin_request_leave", { ...vacation, confirmationToken: data.confirmationToken });
    expect(res.data).toEqual({ requested: true, id: 77 });
    expect(filings()).toMatchObject([{ body: filedBody }]);
  });

  it("rejects a token issued for a different comment", async () => {
    await loggedIn({ elicitation: false });
    const { data } = await h.call("itfin_request_leave", vacation);
    const res = await h.call("itfin_request_leave", { ...vacation, comment: "Two weeks off", confirmationToken: data.confirmationToken });
    expect(res.data.error.code).toBe("CONFIRMATION_INVALID");
    expect(filings()).toHaveLength(0);
  });

  it("rejects a reopen request's token", async () => {
    await loggedIn({ elicitation: false });
    const reopen = await h.call("itfin_request_reopen", { from: "2026-09-14", to: "2026-09-18", reason: "Forgot to report last week" });
    const res = await h.call("itfin_request_leave", { ...vacation, confirmationToken: reopen.data.confirmationToken });
    expect(res.data.error.code).toBe("CONFIRMATION_INVALID");
  });
});

describe("itfin_request_leave validation", () => {
  it("rejects a leave type the user can't request", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: 14 });
    expect(res.data.error).toMatchObject({ code: "VALIDATION", leaveTypes: [{ id: 11 }, { id: 12 }, { id: 13 }] });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("requires a reason from the leave type's list", async () => {
    await loggedIn();
    const missing = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: 12, reason: undefined });
    expect(missing.data.error).toMatchObject({ code: "VALIDATION", reasons: expect.arrayContaining(["Other"]) });
    const unknown = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: 12, reason: "Hangover" });
    expect(unknown.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("sends no reason for leave types without reasons", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: 13, reason: undefined });
    expect(res.data).toEqual({ requested: true, id: 77 });
    expect(filings()[0]!.body).toMatchObject({ TimeoffTypeId: 13, TimeoffType: "Unpaid", Reason: null });
  });

  it("refuses when ITFin says the leave can't be requested", async () => {
    await loggedIn({ info: leaveRequestInfo({ isAvailableToRequest: false, availableDays: 1 }) });
    const res = await h.call("itfin_request_leave", vacation);
    expect(res.data.error).toMatchObject({ code: "VALIDATION", requestedDays: 2, availableDays: 1 });
    expect(filings()).toHaveLength(0);
  });

  it("refuses when ITFin requires attached documents", async () => {
    await loggedIn({ info: leaveRequestInfo({ isAttachFileToRequest: true }) });
    const res = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: 12, reason: "Other" });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(res.data.error.message).toContain("web app");
    expect(filings()).toHaveLength(0);
  });

  it("rejects an empty comment and a reversed range before calling ITFin", async () => {
    await loggedIn();
    expect((await h.call("itfin_request_leave", { ...vacation, comment: " " })).data.error.code).toBe("VALIDATION");
    expect((await h.call("itfin_request_leave", { ...vacation, from: "2026-10-03" })).data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

describe("itfin_cancel_leave_request", () => {
  const myRequests = [
    leaveRequest({ id: 5, type: "Vacation", from: "2026-10-01", to: "2026-10-02", status: "Pending" }),
    leaveRequest({ id: 6, type: "Sickness", from: "2026-09-10", to: "2026-09-10", status: "Canceled" }),
    reopenRequest({ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" }),
  ];

  it("cancels one of the user's leave requests", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", { body: myRequests }).on("DELETE /api/v1/requests/5", { status: 204 });
    const res = await h.call("itfin_cancel_leave_request", { id: 5 });
    expect(res.data).toMatchObject({ cancelled: 5, request: { type: "Vacation", from: "2026-10-01", to: "2026-10-02" } });
    expect(h.itfin.writes()).toMatchObject([{ method: "DELETE", path: "/api/v1/requests/5" }]);
  });

  it("refuses ids that aren't the user's leave requests, such as a reopen request", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", { body: myRequests });
    expect((await h.call("itfin_cancel_leave_request", { id: 7 })).data.error.code).toBe("NOT_FOUND");
    expect((await h.call("itfin_cancel_leave_request", { id: 99 })).data.error.code).toBe("NOT_FOUND");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("refuses a request that is already cancelled", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/requests/my", { body: myRequests });
    const res = await h.call("itfin_cancel_leave_request", { id: 6 });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

