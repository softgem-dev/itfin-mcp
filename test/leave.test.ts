import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { leaveRequest, leaveRequestInfo, leaveTypeStats, leaveTypes, me, reopenRequest, workspace } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

async function loggedIn(opts: { settings?: unknown; info?: unknown; stats?: unknown } = {}) {
  h = await startHarness({ now: "2026-09-24T09:00:00Z" });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  h.itfin
    .on("GET /api/v1/auth", { body: me })
    .on(`GET /api/v1/auth/workspaces/${new URL(h.itfin.url).host}`, { body: opts.settings ?? workspace })
    .on("GET /api/v3/timeoff-types/available/2026-09-24/1001", { body: leaveTypes })
    .on("POST /api/v3/timeoff/stats", { body: opts.stats ?? leaveTypeStats() })
    .on("POST /api/v3/timeoff/request-info", { body: opts.info ?? leaveRequestInfo() })
    .on("POST /api/v2/requests/timeoff", { body: { Id: 77 } });
  return h;
}

const vacation = { leaveTypeId: "YvDrZ", from: "2026-10-01", to: "2026-10-02", reason: "Rest and relax", comment: "Vacation" };
const filedBody = {
  EmployeeId: 1001,
  TimeoffTypeId: "YvDrZ",
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
    expect(res.data.leaveTypes.map((t: { id: string }) => t.id)).toEqual(["YvDrZ", "k3Pq9", "y4JmZ"]);
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

describe("itfin_request_leave", () => {
  it("checks the request with ITFin and files it in one call, with the counted days", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", vacation);
    expect(res).toEqual({ isError: false, data: { requested: true, id: 77, requestedDays: 2, availableDays: 18, minDays: 0 } });
    expect(h.itfin.writes()).toMatchObject([
      { path: "/api/v3/timeoff/request-info", body: { employeeId: 1001, timeoffId: "YvDrZ", dateFrom: "2026-10-01", dateTo: "2026-10-02", isPartDay: false } },
      { path: "/api/v2/requests/timeoff", body: filedBody },
    ]);
  });
});

describe("itfin_request_leave for part of a day", () => {
  const halfDay = { leaveTypeId: "k3Pq9", from: "2026-09-15", to: "2026-09-15", hours: 4, reason: "Other", comment: "Doctor in the morning" };
  const partDayInfo = leaveRequestInfo({ requestedDays: 0.5, requestedHours: 4 });

  it("checks and files it with the web form's part-day fields", async () => {
    await loggedIn({ info: partDayInfo });
    const res = await h.call("itfin_request_leave", halfDay);
    expect(res.data).toMatchObject({ requested: true, id: 77, requestedHours: 4, availableDays: 18 });
    expect(h.itfin.writes()).toMatchObject([
      { path: "/api/v3/timeoff/stats", body: { employeeId: 1001, timeoffTypeIds: ["k3Pq9"], date: "2026-09-24" } },
      {
        path: "/api/v3/timeoff/request-info",
        body: { employeeId: 1001, timeoffId: "k3Pq9", date: "2026-09-15", dateFrom: "2026-09-15", dateTo: "2026-09-15", isPartDay: true, hours: 4, formattedHours: "04h 00m" },
      },
      {
        path: "/api/v2/requests/timeoff",
        body: { TimeoffTypeId: "k3Pq9", TimeoffType: "Sickness", Date: "2026-09-15", DateFrom: "2026-09-15", DateTo: "2026-09-15", IsPartDay: true, FormattedHours: "04h 00m", Hours: 4 },
      },
    ]);
  });

  it("files other hours as given", async () => {
    await loggedIn({ info: partDayInfo });
    const res = await h.call("itfin_request_leave", { ...halfDay, hours: 2.5 });
    expect(res.data).toMatchObject({ requested: true, id: 77 });
    expect(filings()).toMatchObject([{ body: { IsPartDay: true, FormattedHours: "02h 30m", Hours: 2.5 } }]);
  });

  it("covers a single day", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", { ...halfDay, to: "2026-09-16" });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("refuses when the leave type's policy has no part days", async () => {
    await loggedIn({ stats: leaveTypeStats({ isAllowedToRequestPartDay: false }) });
    const res = await h.call("itfin_request_leave", halfDay);
    expect(res.data.error.message).toContain("part of a day");
    expect(h.itfin.writes().map((r) => r.path)).toEqual(["/api/v3/timeoff/stats"]);
  });
});

describe("itfin_request_leave with the id from itfin_list_leave_types", () => {
  // Regression: leaveTypeId was z.number(), so the hash id the list tool returns failed MCP validation.
  const sick = { reason: "SickLeave", comment: "Sick leave" };
  const settings = { Settings: { ...workspace.Settings, AdditionalVacationLeaveReasons: "SickLeave" } };

  it("files a full day with the listed id unchanged", async () => {
    await loggedIn({ settings, info: leaveRequestInfo({ requestedDays: 1 }) });
    const vacationType = (await h.call("itfin_list_leave_types")).data.leaveTypes.find((t: { name: string }) => t.name === "Vacation");
    expect(vacationType).toMatchObject({ id: "YvDrZ", reasons: expect.arrayContaining(["SickLeave"]) });

    const res = await h.call("itfin_request_leave", { ...sick, leaveTypeId: vacationType.id, from: "2026-09-14", to: "2026-09-14" });
    expect(res).toMatchObject({ isError: false, data: { requested: true, id: 77, requestedDays: 1 } });
    expect(filings()).toMatchObject([
      { body: { TimeoffTypeId: "YvDrZ", TimeoffType: "Vacation", DateFrom: "2026-09-14", DateTo: "2026-09-14", IsPartDay: false, Reason: "SickLeave", Comment: "Sick leave" } },
    ]);
  });

  it("files a part day with the listed id unchanged", async () => {
    await loggedIn({ settings, info: leaveRequestInfo({ requestedDays: 0.5, requestedHours: 4 }), stats: leaveTypeStats({ timeoffTypeId: "YvDrZ" }) });
    const [vacationType] = (await h.call("itfin_list_leave_types")).data.leaveTypes;

    const res = await h.call("itfin_request_leave", { ...sick, leaveTypeId: vacationType.id, from: "2026-09-15", to: "2026-09-15", hours: 4, comment: "Sick leave, half day" });
    expect(res.data).toMatchObject({ requested: true, id: 77, requestedHours: 4 });
    expect(h.itfin.writes()).toMatchObject([
      { path: "/api/v3/timeoff/stats", body: { timeoffTypeIds: ["YvDrZ"] } },
      { path: "/api/v3/timeoff/request-info", body: { timeoffId: "YvDrZ", date: "2026-09-15", isPartDay: true, hours: 4 } },
      { path: "/api/v2/requests/timeoff", body: { TimeoffTypeId: "YvDrZ", Date: "2026-09-15", IsPartDay: true, FormattedHours: "04h 00m", Hours: 4, Reason: "SickLeave" } },
    ]);
  });

  it("accepts numeric ids from a workspace that returns them, and sends them back as numbers", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v3/timeoff-types/available/2026-09-24/1001", { body: { timeoffs: [{ id: 11, name: "Vacation", type: "Paid", oldSystemTimeoffName: "Vacation" }] } });
    expect((await h.call("itfin_list_leave_types")).data.leaveTypes[0].id).toBe("11");
    for (const leaveTypeId of [11, "11"]) {
      expect((await h.call("itfin_request_leave", { ...vacation, leaveTypeId })).data).toMatchObject({ requested: true });
    }
    expect(filings().map((r) => (r.body as { TimeoffTypeId: unknown }).TimeoffTypeId)).toEqual([11, 11]);
  });
});

describe("itfin_request_leave validation", () => {
  it("rejects a leave type the user can't request", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: "Zx8Lw" });
    expect(res.data.error).toMatchObject({ code: "VALIDATION", leaveTypes: [{ id: "YvDrZ" }, { id: "k3Pq9" }, { id: "y4JmZ" }] });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("requires a reason from the leave type's list", async () => {
    await loggedIn();
    const missing = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: "k3Pq9", reason: undefined });
    expect(missing.data.error).toMatchObject({ code: "VALIDATION", reasons: expect.arrayContaining(["Other"]) });
    const unknown = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: "k3Pq9", reason: "Hangover" });
    expect(unknown.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("sends no reason for leave types without reasons", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: "y4JmZ", reason: undefined });
    expect(res.data).toMatchObject({ requested: true, id: 77 });
    expect(filings()[0]!.body).toMatchObject({ TimeoffTypeId: "y4JmZ", TimeoffType: "Unpaid", Reason: null });
  });

  it("refuses when ITFin says the leave can't be requested", async () => {
    await loggedIn({ info: leaveRequestInfo({ isAvailableToRequest: false, availableDays: 1 }) });
    const res = await h.call("itfin_request_leave", vacation);
    expect(res.data.error).toMatchObject({ code: "VALIDATION", requestedDays: 2, availableDays: 1 });
    expect(filings()).toHaveLength(0);
  });

  it("refuses when ITFin requires attached documents", async () => {
    await loggedIn({ info: leaveRequestInfo({ isAttachFileToRequest: true }) });
    const res = await h.call("itfin_request_leave", { ...vacation, leaveTypeId: "k3Pq9", reason: "Other" });
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

