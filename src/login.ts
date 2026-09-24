import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

const BROWSERS: Record<string, string> = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  edge: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  arc: "/Applications/Arc.app/Contents/MacOS/Arc",
  chromium: "/Applications/Chromium.app/Contents/MacOS/Chromium",
};

const TOKEN_COOKIE = "itfin-jwt";

export interface LoginSession {
  /** Resolves with the new ITFin token once the user has signed in. */
  token: Promise<string>;
}

/**
 * Opens the workspace in a Chromium-based browser with a dedicated profile and watches, over the
 * DevTools protocol, for the ITFin token cookie that ITFin sets after the user signs in.
 * Nothing is clicked or typed: the user signs in themselves.
 */
export async function startBrowserLogin(opts: { workspaceUrl: string; browser: string; profileDir?: string; maxWaitMs: number }): Promise<LoginSession> {
  const executable = BROWSERS[opts.browser.toLowerCase()] ?? opts.browser;
  if (!existsSync(executable)) throw new Error(`Browser not found: ${executable}. Set ITFIN_BROWSER to chrome, edge, brave, arc, chromium or a path.`);

  const profileDir = opts.profileDir ?? join(homedir(), "Library", "Application Support", "itfin-mcp", "browser-profile");
  mkdirSync(profileDir, { recursive: true });
  const port = await freePort();
  const child = spawn(
    executable,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdio: "ignore", detached: false },
  );

  const token = (async () => {
    const page = await connectToPage(port, opts.maxWaitMs);
    try {
      await page.send("Network.enable");
      // Drop a token left in the profile so the user really signs in and ITFin issues a fresh one.
      await page.send("Network.deleteCookies", { name: TOKEN_COOKIE, url: opts.workspaceUrl });
      await page.send("Page.navigate", { url: opts.workspaceUrl });
      const deadline = Date.now() + opts.maxWaitMs;
      while (Date.now() < deadline) {
        const { cookies } = (await page.send("Network.getCookies", { urls: [opts.workspaceUrl] })) as { cookies: { name: string; value: string }[] };
        const cookie = cookies.find((c) => c.name === TOKEN_COOKIE);
        if (cookie?.value) return decodeURIComponent(cookie.value).replace(/^Bearer\s+/i, "");
        await sleep(1000);
      }
      throw new Error("Timed out waiting for the ITFin login.");
    } finally {
      page.close();
      closeBrowser(child, port);
    }
  })();

  return { token };
}

interface CdpPage {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

async function connectToPage(port: number, maxWaitMs: number): Promise<CdpPage> {
  const deadline = Date.now() + Math.min(maxWaitMs, 30_000);
  let wsUrl: string | undefined;
  while (!wsUrl) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      wsUrl = targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // Browser still starting.
    }
    if (!wsUrl) {
      if (Date.now() > deadline) throw new Error("The login browser did not start.");
      await sleep(250);
    }
  }
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve(), { once: true });
    ws.addEventListener("error", () => reject(new Error("Could not connect to the login browser.")), { once: true });
  });
  let nextId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (msg.id === undefined) return;
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p?.reject(new Error(msg.error.message));
    else p?.resolve(msg.result);
  });
  ws.addEventListener("close", () => {
    for (const p of pending.values()) p.reject(new Error("The login browser was closed."));
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => ws.close(),
  };
}

function closeBrowser(child: ChildProcess, port: number): void {
  fetch(`http://127.0.0.1:${port}/json/version`)
    .then((r) => r.json() as Promise<{ webSocketDebuggerUrl: string }>)
    .then(({ webSocketDebuggerUrl }) => {
      const ws = new WebSocket(webSocketDebuggerUrl);
      ws.addEventListener("open", () => ws.send(JSON.stringify({ id: 1, method: "Browser.close" })));
    })
    .catch(() => child.kill());
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
