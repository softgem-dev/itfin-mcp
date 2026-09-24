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
const filedBody = { RequestType: "OpenReporting", EmployeeId: 1001, DateFrom: "2026-09-14", DateTo: "2026-09-18", Comment: "Forgot to report last week" };

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

describe("itfin_request_reopen with a confirmation form", () => {
  it("files the reopen request when the user accepts the form", async () => {
    await loggedIn();
    const res = await h.call("itfin_request_reopen", request);
    expect(res).toEqual({ isError: false, data: { requested: true, id: 55 } });
    expect(h.itfin.writes()).toMatchObject([{ method: "POST", path: "/api/v1/requests/open-reporting", body: filedBody }]);
  });

  it("files the reopen request when the user accepts with the box ticked", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "accept", content: { confirm: true } };
    expect((await h.call("itfin_request_reopen", request)).data).toEqual({ requested: true, id: 55 });
  });

  it("files nothing when the user accepts but unticks the box", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "accept", content: { confirm: false } };
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error).toMatchObject({ code: "CONFIRMATION_DECLINED", elicitation: { action: "accept", confirm: false } });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("files nothing when the user declines", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "decline" };
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error).toMatchObject({ code: "CONFIRMATION_DECLINED", elicitation: { action: "decline" } });
    expect(res.data.error.elicitation.elapsedMs).toBeGreaterThanOrEqual(40);
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("files nothing when the user dismisses the form", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "cancel" };
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data.error).toMatchObject({ code: "CONFIRMATION_CANCELLED", elicitation: { action: "cancel" } });
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

describe("itfin_request_reopen confirmed in chat", () => {
  it("returns a preview and a confirmation token when the host cannot show forms", async () => {
    await loggedIn({ elicitation: false });
    const res = await h.call("itfin_request_reopen", request);
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ requested: false, needsUserConfirmation: true, preview: request, confirmationToken: expect.any(String) });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("falls back to the confirmation token when the client declines without showing the form", async () => {
    await loggedIn();
    h.elicitAnswer = { action: "decline" };
    h.elicitDelayMs = 0;
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data).toMatchObject({ requested: false, needsUserConfirmation: true, confirmationToken: expect.any(String) });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("does not treat an instant accept as consent", async () => {
    await loggedIn();
    h.elicitDelayMs = 0;
    const res = await h.call("itfin_request_reopen", request);
    expect(res.data).toMatchObject({ requested: false, needsUserConfirmation: true });
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("files the reopen request when called again with the confirmation token", async () => {
    await loggedIn({ elicitation: false });
    const { data } = await h.call("itfin_request_reopen", request);
    const res = await h.call("itfin_request_reopen", { ...request, confirmationToken: data.confirmationToken });
    expect(res.data).toEqual({ requested: true, id: 55 });
    expect(h.itfin.writes()).toMatchObject([{ body: filedBody }]);
  });

  it("accepts a confirmation token only once", async () => {
    await loggedIn({ elicitation: false });
    const { data } = await h.call("itfin_request_reopen", request);
    await h.call("itfin_request_reopen", { ...request, confirmationToken: data.confirmationToken });
    const again = await h.call("itfin_request_reopen", { ...request, confirmationToken: data.confirmationToken });
    expect(again.data.error.code).toBe("CONFIRMATION_INVALID");
    expect(h.itfin.writes()).toHaveLength(1);
  });

  it("rejects a confirmation token used for different dates or reason", async () => {
    await loggedIn({ elicitation: false });
    const { data } = await h.call("itfin_request_reopen", request);
    const res = await h.call("itfin_request_reopen", { ...request, to: "2026-09-30", confirmationToken: data.confirmationToken });
    expect(res.data.error.code).toBe("CONFIRMATION_INVALID");
    expect(h.itfin.writes()).toHaveLength(0);
  });

  it("rejects a confirmation token after 10 minutes", async () => {
    await loggedIn({ elicitation: false });
    const { data } = await h.call("itfin_request_reopen", request);
    h.setNow("2026-09-24T09:10:01Z");
    const res = await h.call("itfin_request_reopen", { ...request, confirmationToken: data.confirmationToken });
    expect(res.data.error.code).toBe("CONFIRMATION_INVALID");
    expect(h.itfin.writes()).toHaveLength(0);
  });
});

describe("itfin_request_reopen validation", () => {
  it("rejects a reason shorter than 10 characters before asking the user", async () => {
    await loggedIn();
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
