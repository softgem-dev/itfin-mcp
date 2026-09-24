import { afterEach, describe, expect, it } from "vitest";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { trackingRoute } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

describe("itfin_auth_status", () => {
  it("reports no ITFin token before the first login", async () => {
    h = await startHarness({ now: "2026-09-24T09:00:00Z" });
    const res = await h.call("itfin_auth_status");
    expect(res.isError).toBe(false);
    expect(res.data).toMatchObject({ valid: false, reason: "no_token" });
  });

  it("reports a valid ITFin token with its expiry and email", async () => {
    h = await startHarness({ now: "2026-09-24T09:00:00Z" });
    h.itfin.on("GET /api/v1/tracking", trackingRoute({ today: "2026-09-24" }));
    await h.store.save(makeJwt({ iat: sec("2026-09-24T14:04:59Z"), exp: sec("2026-10-01T14:04:59Z") }));

    const res = await h.call("itfin_auth_status");
    expect(res.data).toMatchObject({ valid: true, email: "test.user@example.com", expiresAt: "2026-10-01T14:04:59.000Z" });
  });

  it("treats an ITFin token within 5 minutes of expiry as expired", async () => {
    h = await startHarness({ now: "2026-10-01T14:00:00Z" });
    await h.store.save(makeJwt({ iat: sec("2026-09-24T14:04:59Z"), exp: sec("2026-10-01T14:04:59Z") }));
    const res = await h.call("itfin_auth_status");
    expect(res.data).toMatchObject({ valid: false, reason: "expired", expiresAt: "2026-10-01T14:04:59.000Z" });
  });
});

describe("relogin reminder time", () => {
  it("is the start of working time on the expiry day when the ITFin token expires during it", async () => {
    // Expires Thu 2026-10-01 17:04 Kyiv -> remind Thu 10:00 Kyiv (07:00Z).
    h = await startHarness({ now: "2026-09-24T09:00:00Z" });
    h.itfin.on("GET /api/v1/tracking", trackingRoute({ today: "2026-09-24" }));
    await h.store.save(makeJwt({ iat: sec("2026-09-24T14:04:59Z"), exp: sec("2026-10-01T14:04:59Z") }));
    const res = await h.call("itfin_auth_status");
    expect(res.data.nextReminderAt).toBe("2026-10-01T07:00:00.000Z");
  });

  it("moves back to the last working day when the ITFin token expires on a weekend", async () => {
    // Expires Sun 2026-09-27 -> remind Fri 2026-09-25 10:00 Kyiv.
    h = await startHarness({ now: "2026-09-21T09:00:00Z" });
    h.itfin.on("GET /api/v1/tracking", trackingRoute({ today: "2026-09-21" }));
    await h.store.save(makeJwt({ iat: sec("2026-09-20T12:00:00Z"), exp: sec("2026-09-27T12:00:00Z") }));
    const res = await h.call("itfin_auth_status");
    expect(res.data.nextReminderAt).toBe("2026-09-25T07:00:00.000Z");
  });

  it("skips holidays taken from ITFin", async () => {
    h = await startHarness({ now: "2026-09-21T09:00:00Z" });
    h.itfin.on("GET /api/v1/tracking", trackingRoute({ today: "2026-09-21", days: { "2026-09-25": { isHoliday: true } } }));
    await h.store.save(makeJwt({ iat: sec("2026-09-20T12:00:00Z"), exp: sec("2026-09-27T12:00:00Z") }));
    const res = await h.call("itfin_auth_status");
    expect(res.data.nextReminderAt).toBe("2026-09-24T07:00:00.000Z");
  });

  it("does not use a working day whose working time starts after the expiry", async () => {
    // Expires Thu 06:00Z = 09:00 Kyiv, before 10:00 -> remind Wed 10:00 Kyiv.
    h = await startHarness({ now: "2026-09-28T09:00:00Z" });
    h.itfin.on("GET /api/v1/tracking", trackingRoute({ today: "2026-09-28" }));
    await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
    const res = await h.call("itfin_auth_status");
    expect(res.data.nextReminderAt).toBe("2026-09-30T07:00:00.000Z");
  });

  it("is due now when the reminder time has already passed", async () => {
    // Expires Thu 17:04 Kyiv; it is Thu 12:00 Kyiv, past 10:00 -> remind now.
    h = await startHarness({ now: "2026-10-01T09:00:00Z" });
    h.itfin.on("GET /api/v1/tracking", trackingRoute({ today: "2026-10-01" }));
    await h.store.save(makeJwt({ iat: sec("2026-09-24T14:04:59Z"), exp: sec("2026-10-01T14:04:59Z") }));
    const res = await h.call("itfin_auth_status");
    expect(res.data.nextReminderAt).toBe("2026-10-01T09:00:00.000Z");
  });
});
