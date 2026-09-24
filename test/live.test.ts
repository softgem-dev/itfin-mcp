// Opt-in, read-only smoke test against a real ITFin workspace, to catch API drift.
// Run: ITFIN_LIVE=1 ITFIN_URL=https://<workspace>.itfin.io npx vitest run test/live.test.ts
// Needs a token from itfin_login stored in the Keychain.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";
import { loadConfig } from "../src/config.js";
import { createItfinServer } from "../src/server.js";
import { KeychainTokenStore } from "../src/tokenStore.js";

describe.runIf(process.env.ITFIN_LIVE === "1")("live ITFin workspace (read-only)", () => {
  it("reads token status, projects, time entries, settings, reopen and leave requests", async () => {
    const config = loadConfig();
    const server = createItfinServer({ config, clock: systemClock, tokenStore: new KeychainTokenStore("itfin-mcp", config.workspaceUrl) });
    const client = new Client({ name: "live-smoke", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      expect(res.isError, res.content[0]!.text).toBeFalsy();
      return JSON.parse(res.content[0]!.text);
    };
    const today = DateTime.now().setZone(config.timezone);

    expect((await call("itfin_auth_status")).valid).toBe(true);
    const { projects } = await call("itfin_list_projects", { date: today.toISODate() });
    expect(Array.isArray(projects)).toBe(true);
    const { days } = await call("itfin_get_entries", { from: today.startOf("week").toISODate(), to: today.endOf("week").toISODate() });
    expect(days).toHaveLength(7);
    expect(days[0]).toHaveProperty("status");
    expect(await call("itfin_get_workspace_settings")).toHaveProperty("minCommentLength");
    expect(await call("itfin_list_reopen_requests")).toHaveProperty("requests");
    expect(Array.isArray((await call("itfin_list_leave_types")).leaveTypes)).toBe(true);
    expect(await call("itfin_list_leave_requests")).toHaveProperty("requests");
    await client.close();
  });
});
