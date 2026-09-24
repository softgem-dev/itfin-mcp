import { ToolError, TRACKING_NOT_ALLOWED } from "./errors.js";

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Send without the ITFin token (public endpoints). */
  anonymous?: boolean;
}

const MAX_ATTEMPTS = 3;
/** Only these are retried; a retried POST could create a second time entry or reopen request. */
const RETRYABLE_METHODS = new Set(["GET", "PUT", "DELETE"]);

/** Thin HTTP client for `<workspace>/api`, mapping ITFin failures onto tool errors. */
export class ItfinClient {
  constructor(
    private readonly workspaceUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly retryDelayMs: number,
    /** Called with the token ITFin rejected with a 401. */
    private readonly onUnauthorized: (token: string) => Promise<void>,
  ) {}

  get<T>(path: string, query?: RequestOptions["query"]): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.workspaceUrl}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    const token = opts.anonymous ? undefined : await this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    const maxAttempts = RETRYABLE_METHODS.has(method) ? MAX_ATTEMPTS : 1;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      } catch (err) {
        if (attempt < maxAttempts) {
          await this.backoff(attempt);
          continue;
        }
        throw new ToolError("ITFIN_ERROR", `ITFin is unreachable: ${(err as Error).message}`);
      }
      if (res.status >= 500 && attempt < maxAttempts) {
        await this.backoff(attempt);
        continue;
      }
      const text = await res.text();
      const data = text ? safeJson(text) : undefined;
      if (res.ok) return data as T;

      const message = (data as { message?: string } | undefined)?.message ?? (text || res.statusText);
      if (res.status === 401) {
        if (token) await this.onUnauthorized(token);
        throw new ToolError("AUTH_REQUIRED", `ITFin rejected the token (${message}). Ask the user to log in.`);
      }
      if (res.status === 400 && message === TRACKING_NOT_ALLOWED) throw new ToolError("DAY_CLOSED", message);
      if (res.status === 404) throw new ToolError("NOT_FOUND", message, { status: 404 });
      throw new ToolError("ITFIN_ERROR", message, { status: res.status });
    }
  }

  private backoff(attempt: number): Promise<void> {
    return new Promise((r) => setTimeout(r, this.retryDelayMs * 2 ** (attempt - 1)));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}
