import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { logEntry, projectsForDate, trackingRoute } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

async function loggedIn(now = "2026-09-24T09:00:00Z") {
  h = await startHarness({ now });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  return h;
}

describe("itfin_get_entries", () => {
  it("returns days with their time entries and status for a date range", async () => {
    await loggedIn();
    h.itfin.on(
      "GET /api/v1/tracking",
      trackingRoute({
        today: "2026-09-24",
        days: { "2026-09-22": { log: [logEntry({ id: 42, date: "2026-09-22", minutes: 480, comment: "Releasing identity changes" })] } },
      }),
    );

    const res = await h.call("itfin_get_entries", { from: "2026-09-18", to: "2026-09-25" });

    expect(res.isError).toBe(false);
    const byDate = Object.fromEntries(res.data.days.map((d: any) => [d.date, d]));
    expect(byDate["2026-09-18"].status).toBe("closed");
    expect(byDate["2026-09-22"]).toMatchObject({
      status: "open",
      totalMinutes: 480,
      businessHours: 8,
      entries: [{ id: 42, date: "2026-09-22", projectId: 301, projectName: "Alpha", clientAgreementId: 5001, taskId: null, minutes: 480, comment: "Releasing identity changes" }],
    });
    expect(byDate["2026-09-24"].status).toBe("open");
    expect(byDate["2026-09-25"].status).toBe("future");
    expect(h.itfin.requests.at(-1)!.headers.authorization).toMatch(/^Bearer ey/);
  });

  it("fails with AUTH_REQUIRED and calls nothing when there is no ITFin token", async () => {
    h = await startHarness({ now: "2026-09-24T09:00:00Z" });
    const res = await h.call("itfin_get_entries", { from: "2026-09-21", to: "2026-09-27" });
    expect(res.isError).toBe(true);
    expect(res.data.error.code).toBe("AUTH_REQUIRED");
    expect(h.itfin.requests).toHaveLength(0);
  });

  it("fails with AUTH_REQUIRED without retrying when ITFin answers 401", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/tracking", { status: 401, body: { message: "invalid signature" } });
    const res = await h.call("itfin_get_entries", { from: "2026-09-21", to: "2026-09-27" });
    expect(res.data.error.code).toBe("AUTH_REQUIRED");
    expect(h.itfin.requests).toHaveLength(1);
  });

  it("retries 5xx responses before giving up with the ITFin message", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/tracking", { status: 503, body: { message: "Service unavailable" } });
    const res = await h.call("itfin_get_entries", { from: "2026-09-21", to: "2026-09-27" });
    expect(res.data.error).toMatchObject({ code: "ITFIN_ERROR", message: "Service unavailable" });
    expect(h.itfin.requests).toHaveLength(3);
  });

  it("succeeds when a retry after a 5xx works", async () => {
    await loggedIn();
    let calls = 0;
    const ok = trackingRoute({ today: "2026-09-24" });
    h.itfin.on("GET /api/v1/tracking", (req) => (++calls === 1 ? { status: 502 } : ok(req)));
    const res = await h.call("itfin_get_entries", { from: "2026-09-21", to: "2026-09-21" });
    expect(res.isError).toBe(false);
    expect(res.data.days).toHaveLength(1);
  });

  it("rejects a range whose end is before its start", async () => {
    await loggedIn();
    const res = await h.call("itfin_get_entries", { from: "2026-09-27", to: "2026-09-21" });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.requests).toHaveLength(0);
  });
});

describe("itfin_list_projects", () => {
  it("lists the projects reportable on a date with agreement ids and tasks", async () => {
    await loggedIn();
    h.itfin.on("GET /api/v1/tracking/tasks", { body: projectsForDate });

    const res = await h.call("itfin_list_projects", { date: "2026-09-24" });

    expect(res.data.projects).toEqual([
      { projectId: 301, projectName: "Alpha", clientAgreementId: 5001, billable: false, tasks: [{ id: 71, name: "Code review" }] },
    ]);
    expect(h.itfin.requests[0]!.query).toMatchObject({ Date: "2026-09-24" });
  });
});
