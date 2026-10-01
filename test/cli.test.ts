import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { makeJwt, sec, startHarness, type Harness } from "./harness.js";
import { me, trackingRoute, workspace } from "./fixtures.js";

let h: Harness;
afterEach(async () => h?.close());

const TODAY = "2026-09-24";

async function loggedIn() {
  h = await startHarness({ now: "2026-09-24T09:00:00Z" });
  await h.store.save(makeJwt({ iat: sec("2026-09-24T06:00:00Z"), exp: sec("2026-10-01T06:00:00Z") }));
  const host = new URL(h.itfin.url).host;
  h.itfin
    .on("GET /api/v1/tracking", trackingRoute({ today: TODAY }))
    .on("GET /api/v1/auth", { body: me })
    .on(`GET /api/v1/auth/workspaces/${host}`, { body: workspace })
    .on("GET /api/v1/requests/my", { body: [] })
    .on("POST /api/v1/tracking", { body: { Id: 900 } });
  return h;
}

async function cli(...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  let logins = 0;
  const code = await runCli(argv, {
    client: h.client,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    startLogin: async () => {
      logins++;
      return { status: "waiting" };
    },
  });
  return { code, out: out.join("\n"), err: err.join("\n"), logins };
}

describe("CLI mode", () => {
  it("runs a tool as a kebab-case command and prints its JSON result", async () => {
    await loggedIn();
    const res = await cli("get-entries", "--from", TODAY, `--to=${TODAY}`);
    expect(res.code).toBe(0);
    expect(JSON.parse(res.out).days).toEqual([expect.objectContaining({ date: TODAY, status: "open" })]);
  });

  it("turns kebab-case flags into typed parameters", async () => {
    await loggedIn();
    const res = await cli("create-entry", "--date", TODAY, "--client-agreement-id", "5001", "--minutes", "90", "--comment", "Reviewed pull requests", "--task-id", "71");
    expect(res).toMatchObject({ code: 0, out: '{"id":900}' });
    expect(h.itfin.writes()[0]!.body).toMatchObject({ ClientAgreementId: 5001, TaskId: 71, MinutesInt: 90 });
  });

  it("takes all parameters at once with --json", async () => {
    await loggedIn();
    const res = await cli("create-entry", "--json", JSON.stringify({ date: TODAY, clientAgreementId: 5001, minutes: 30, comment: "Reviewed pull requests" }));
    expect(res.code).toBe(0);
  });

  it("prints tool errors as JSON on stderr with exit code 1", async () => {
    await loggedIn();
    const res = await cli("create-entry", "--date", TODAY, "--client-agreement-id", "5001", "--minutes", "90", "--comment", "fix");
    expect(res.code).toBe(1);
    expect(res.out).toBe("");
    expect(JSON.parse(res.err).error).toMatchObject({ code: "VALIDATION", minCommentLength: 10 });
  });

  it("reports invalid parameters as a VALIDATION error", async () => {
    await loggedIn();
    const res = await cli("get-entries", "--from", "yesterday", "--to", TODAY);
    expect(res.code).toBe(1);
    expect(JSON.parse(res.err).error.code).toBe("VALIDATION");
  });

  it("rejects unknown commands and flags without calling ITFin", async () => {
    await loggedIn();
    expect(JSON.parse((await cli("get-entires")).err).error.code).toBe("USAGE");
    expect(JSON.parse((await cli("get-entries", "--form", TODAY)).err).error.code).toBe("USAGE");
    expect(h.itfin.requests).toHaveLength(0);
  });

  it("starts login in the background instead of waiting for the user", async () => {
    await loggedIn();
    const res = await cli("login");
    expect(res).toMatchObject({ code: 0, logins: 1 });
  });

  it("documents every tool in the help, the skill and the read-only list", async () => {
    await loggedIn();
    const { tools } = await h.client.listTools();
    const help = (await cli("--help")).out;
    const skill = (await cli("__skill")).out;
    for (const t of tools) {
      const command = t.name.replace(/^itfin_/, "").replaceAll("_", "-");
      expect(help).toContain(command);
      expect(skill).toContain(`### itfin ${command}`);
    }
    expect(skill).toMatch(/^---\nname: itfin\ndescription: /);
    expect(skill).toContain("Never open or drive a browser");
    expect((await cli("create-entry", "--help")).out).toContain("--client-agreement-id (integer, required)");

    const readOnly = (await cli("__read-only")).out.split("\n");
    expect(readOnly).toEqual(expect.arrayContaining(["get-entries", "list-projects", "auth-status"]));
    expect(readOnly).not.toContain("login");
    expect(readOnly).not.toContain("create-entry");
    expect(readOnly).not.toContain("request-leave");
  });
});

describe("loadConfig", () => {
  function configFile(content: object) {
    const file = join(mkdtempSync(join(tmpdir(), "itfin-config-")), "config.json");
    writeFileSync(file, JSON.stringify(content));
    return file;
  }

  it("reads the settings from the installer's config file", () => {
    const file = configFile({ url: "https://acme.itfin.io/", browser: "brave", workStart: "09:00", timezone: "Europe/Kyiv", apps: { claude: "cli" } });
    expect(loadConfig({}, file)).toEqual({ workspaceUrl: "https://acme.itfin.io", browser: "brave", workStart: "09:00", timezone: "Europe/Kyiv" });
  });

  it("lets env vars override single settings", () => {
    const file = configFile({ url: "https://acme.itfin.io", browser: "brave" });
    expect(loadConfig({ ITFIN_BROWSER: "arc" }, file)).toMatchObject({ workspaceUrl: "https://acme.itfin.io", browser: "arc", workStart: "10:00" });
  });

  it("finds the file through ITFIN_CONFIG and works without one", () => {
    const file = configFile({ url: "https://acme.itfin.io" });
    expect(loadConfig({ ITFIN_CONFIG: file }).workspaceUrl).toBe("https://acme.itfin.io");
    expect(loadConfig({ ITFIN_URL: "https://beta.itfin.io" }, join(tmpdir(), "missing", "config.json")).workspaceUrl).toBe("https://beta.itfin.io");
    expect(() => loadConfig({}, join(tmpdir(), "missing", "config.json"))).toThrow(/No ITFin workspace/);
  });
});
