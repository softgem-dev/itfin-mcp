import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { me, reopenRequest, workspace } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

async function loggedIn(opts: { elicitation?: boolean; settings?: unknown } = {}) {
  h = await startHarness({ now: "2026-09-24T09:00:00Z", elicitation: opts.elicitation });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  h.itfin
    .on("GET /api/v1/auth", { body: me })
    .on(`GET /api/v1/auth/workspaces/${new URL(h.itfin.url).host}`, { body: opts.settings ?? workspace })
    .on("GET /api/v1/requests/my", { body: [reopenRequest({ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" })] })
    .on("POST /api/v1/requests/open-reporting", { body: { Id: 55 } });
  return h;
}

const request = { from: "2026-09-14", to: "2026-09-18", reason: "Forgot to report last week" };

describe("itfin_get_workspace_settings", () => {
  it("returns the minimum comment length and whether reopen requests are enabled", async () => {
    await loggedIn();
    const res = await h.call("itfin_get_workspace_settings");
    expect(res.data).toEqual({ minCommentLength: 10, reopenRequestsEnabled: true });
  });
});

describe("itfin_list_reopen_requests", () => {
  it("lists the user's reopen requests with their status", async () => {
    await loggedIn();
    const res = await h.call("itfin_list_reopen_requests");
    expect(res.data.requests).toMatchObject([{ id: 7, from: "2026-09-14", to: "2026-09-20", status: "Pending" }]);
    expect(h.itfin.requests.at(-1)!.query).toMatchObject({ "filter[requestType]": "OpenReporting" });
  });
});

describe("itfin_request_reopen", () => {
  it("files the reopen request after the user confirms it", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_reopen", request);

    expect(res).toEqual({ isError: false, data: { requested: true, id: 55 } });
    const [post] = h.itfin.writes();
    expect(post).toMatchObject({ method: "POST", path: "/api/v1/requests/open-reporting" });
    expect(post!.body).toEqual({
      RequestType: "OpenReporting",
      EmployeeId: 1001,
      DateFrom: "2026-09-14",
      DateTo: "2026-09-18",
      Comment: "Forgot to report last week",
    });
  });

  it("files nothing when the user declines", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "decline" };
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error.code).toBe("CONFIRMATION_DECLINED");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("files nothing when the user does not tick the confirmation", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "accept", content: { confirm: false } };
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error.code).toBe("CONFIRMATION_DECLINED");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("files nothing when the host cannot ask the user", async () => {
    await loggedIn({ elicitation: false });
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error.code).toBe("CONFIRMATION_UNAVAILABLE");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("rejects a reason shorter than 10 characters before asking the user", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "cancel" };
    const res = await h.call("itfin_request_reopen", { ...request, reason: "forgot" });
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("refuses when the workspace has reopen requests disabled", async () => {
    await loggedIn({ settings: { Settings: { TrackingMinCommentLength: 10, OpenReportingApprovals: { Enabled: false } } } });
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error.code).toBe("VALIDATION");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});
