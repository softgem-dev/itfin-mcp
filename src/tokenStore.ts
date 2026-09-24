import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface StoredToken {
  token: string;
  /** Employee id of the logged-in user, cached after the first lookup. */
  employeeId?: number;
}

export interface TokenStore {
  load(): Promise<StoredToken | undefined>;
  save(token: string, extra?: Omit<StoredToken, "token">): Promise<void>;
  clear(): Promise<void>;
}

/** Keeps the ITFin token in the macOS Keychain as a generic password: service + workspace address. */
export class KeychainTokenStore implements TokenStore {
  constructor(
    private readonly service: string,
    private readonly account: string,
  ) {}

  async load(): Promise<StoredToken | undefined> {
    try {
      const { stdout } = await run("security", ["find-generic-password", "-s", this.service, "-a", this.account, "-w"]);
      return JSON.parse(stdout.trim()) as StoredToken;
    } catch {
      return undefined;
    }
  }

  async save(token: string, extra: Omit<StoredToken, "token"> = {}): Promise<void> {
    const value = JSON.stringify({ token, ...extra });
    // Pass the secret on stdin (security -i), not argv, so it never shows up in the process list.
    const cmd = `add-generic-password -U -s ${quote(this.service)} -a ${quote(this.account)} -w ${quote(value)}\n`;
    await new Promise<void>((resolve, reject) => {
      const child = spawn("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 && !stderr.trim() ? resolve() : reject(new Error(`Keychain write failed: ${stderr.trim() || code}`))));
      child.stdin.end(cmd);
    });
  }

  async clear(): Promise<void> {
    await run("security", ["delete-generic-password", "-s", this.service, "-a", this.account]).catch(() => undefined);
  }
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
