import { ToolError, TRACKING_NOT_ALLOWED } from "./errors.js";

export interface RequestOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Send without the ITFin token (public endpoints). */
  anonymous?: boolean;
}

const MAX_ATTEMPTS = 3;

/** Thin HTTP client for `<workspace>/api`, mapping ITFin failures onto tool errors. */
export class ItfinClient {
  constructor(
    private readonly workspaceUrl: string,
    private readonly getToken: () => Promise<string>,
    private readonly retryDelayMs: number,
  ) {}

  get<T>(path: string, query?: RequestOptions["query"], anonymous = false): Promise<T> {
    return this.request<T>("GET", path, { query, anonymous });
  }

  async request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const url = new URL(`${this.workspaceUrl}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const headers: Record<string, string> = { accept: "application/json" };
    if (!opts.anonymous) headers.authorization = `Bearer ${await this.getToken()}`;
    if (opts.body !== undefined) headers["content-type"] = "application/json";

    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
      } catch (err) {
        if (attempt < MAX_ATTEMPTS) {
          await this.backoff(attempt);
          continue;
        }
        throw new ToolError("ITFIN_ERROR", `ITFin is unreachable: ${(err as Error).message}`);
      }
      if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
        await this.backoff(attempt);
        continue;
      }
      const text = await res.text();
      const data = text ? safeJson(text) : undefined;
      if (res.ok) return data as T;

      const message = (data as { message?: string } | undefined)?.message ?? (text || res.statusText);
      if (res.status === 401) throw new ToolError("AUTH_REQUIRED", `ITFin rejected the token (${message}). Ask the user to log in.`);
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
