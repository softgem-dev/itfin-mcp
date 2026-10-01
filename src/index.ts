#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { runCli } from "./cli.js";
import { systemClock } from "./clock.js";
import { DEFAULT_CONFIG_FILE, loadConfig } from "./config.js";
import { LaunchdReminderScheduler } from "./reminders.js";
import { createItfinServer } from "./server.js";
import { KeychainTokenStore } from "./tokenStore.js";

// `npx itfin-mcp install [flags]` runs the installer shipped in the package. `itfin-mcp cli ...` is
// CLI mode (the installer's `itfin` command runs it). Without arguments this is the MCP server.
if (process.argv[2] === "install") {
  const script = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
  const result = spawnSync("bash", [script, ...process.argv.slice(3)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const config = loadConfig();
const reminders = new LaunchdReminderScheduler();
const server = createItfinServer({
  config,
  clock: systemClock,
  tokenStore: new KeychainTokenStore("itfin-mcp", config.workspaceUrl),
  reminders,
});

if (process.argv[2] !== "cli") {
  await server.connect(new StdioServerTransport());
} else {
  const client = new Client({ name: "itfin-cli", version: "0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const argv = process.argv.slice(3);
  if (argv[0] === "__login-wait") await waitForLogin(client);
  else process.exitCode = await runCli(argv, { client, out: (t) => console.log(t), err: (t) => console.error(t), startLogin: startLoginWaiter });
}

/** Marks a running background login, so a second `itfin login` doesn't open another window. */
function loginPidFile(): string {
  return join(dirname(process.env.ITFIN_CONFIG?.trim() || DEFAULT_CONFIG_FILE), "login.pid");
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Shell tools time out long before a person signs in, so the login waits in a detached process. */
async function startLoginWaiter() {
  const pidFile = loginPidFile();
  const pid = Number(readFileSafe(pidFile));
  if (pid && isRunning(pid)) return { status: "waiting", message: "The login window is already open. The user will get a notification once they have signed in." };
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "cli", "__login-wait"], { detached: true, stdio: "ignore", env: process.env });
  child.unref();
  mkdirSync(dirname(pidFile), { recursive: true });
  writeFileSync(pidFile, String(child.pid));
  return { status: "waiting", message: "A login window is opening. The user will get a notification once they have signed in; check with itfin auth-status." };
}

async function waitForLogin(client: Client): Promise<void> {
  const pidFile = loginPidFile();
  process.on("exit", () => {
    if (readFileSafe(pidFile) === String(process.pid)) rmSync(pidFile, { force: true });
  });
  const res = (await client.callTool({ name: "itfin_login", arguments: {} })) as { isError?: boolean; content: { text?: string }[] };
  const data = JSON.parse(res.content[0]?.text ?? "{}");
  // "waiting": the server keeps watching and notifies on its own.
  if (res.isError) await reminders.notify("ITFin", `Login failed: ${data.error?.message ?? "unknown error"}`);
  else if (data.status === "logged_in") await reminders.notify("ITFin", "Logged in to ITFin.");
}

function readFileSafe(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return undefined;
  }
}
