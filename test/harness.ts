import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createItfinServer } from "../src/server.js";
import { KeychainTokenStore } from "../src/tokenStore.js";
import type { Config } from "../src/config.js";

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage["headers"];
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  body?: unknown;
}

type Handler = (req: RecordedRequest) => FakeResponse | undefined;

/** A fake ITFin backend. Routes are keyed as "METHOD /api/path" (no query string). */
export class FakeItfin {
  readonly requests: RecordedRequest[] = [];
  private routes = new Map<string, Handler>();
  private server: Server | undefined;
  url = "";

  on(route: string, handler: Handler | FakeResponse): this {
    this.routes.set(route, typeof handler === "function" ? handler : () => handler);
    return this;
  }

  writes(): RecordedRequest[] {
    return this.requests.filter((r) => r.method !== "GET");
  }

  async start(): Promise<void> {
    this.server = createHttpServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString();
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      this.requests.push(recorded);
      const handler = this.routes.get(`${recorded.method} ${recorded.path}`);
      const response = handler?.(recorded) ?? { status: 404, body: { message: "Not found" } };
      res.statusCode = response.status ?? 200;
      if (response.body === undefined) return res.end();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(response.body));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}

/** Builds an unsigned JWT with the given claims; the server only decodes it. */
export function makeJwt(claims: { Email?: string; iat: number; exp: number }): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ Email: "test.user@example.com", OwnerId: 2, aud: "itfin-users", iss: "itfin-prod", ...claims })}.signature`;
}

export const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);

export const TEST_KEYCHAIN_SERVICE = "itfin-mcp-test";

/** Answers faster than this count as "the client answered without showing the form". */
const INSTANT_ANSWER_MS = 40;
/** A simulated human answer time, comfortably above INSTANT_ANSWER_MS. */
export const HUMAN_MS = 80;

export interface Harness {
  itfin: FakeItfin;
  client: Client;
  store: KeychainTokenStore;
  setNow(iso: string): void;
  call(name: string, args?: Record<string, unknown>): Promise<{ isError: boolean; data: any }>;
  /** Answer the next confirmation prompts from the server with this action. */
  elicitAnswer: { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };
  /** How long the simulated user takes to answer; 0 mimics a client that answers without showing the form. */
  elicitDelayMs: number;
  close(): Promise<void>;
}

export async function startHarness(opts: { now: string; config?: Partial<Config>; elicitation?: boolean }): Promise<Harness> {
  const itfin = new FakeItfin();
  await itfin.start();
  let now = new Date(opts.now);
  const config: Config = {
    workspaceUrl: itfin.url,
    browser: "chrome",
    workStart: "10:00",
    timezone: "Europe/Kyiv",
    ...opts.config,
  };
  const store = new KeychainTokenStore(TEST_KEYCHAIN_SERVICE, config.workspaceUrl);
  await store.clear();
  const server = createItfinServer({ config, clock: { now: () => now }, tokenStore: store, retryDelayMs: 0, instantAnswerMs: INSTANT_ANSWER_MS });

  const client = new Client(
    { name: "test-client", version: "0" },
    { capabilities: opts.elicitation === false ? {} : { elicitation: {} } },
  );
  const harness: Harness = {
    itfin,
    client,
    store,
    elicitAnswer: { action: "accept" },
    elicitDelayMs: HUMAN_MS,
    setNow(iso) {
      now = new Date(iso);
    },
    async call(name, args = {}) {
      const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { type: string; text: string }[] };
      return { isError: Boolean(res.isError), data: JSON.parse(res.content[0]!.text) };
    },
    async close() {
      await client.close();
      await server.close();
      await store.clear();
      await itfin.stop();
    },
  };
  if (opts.elicitation !== false) {
    client.setRequestHandler(ElicitRequestSchema, async () => {
      await new Promise((r) => setTimeout(r, harness.elicitDelayMs));
      return harness.elicitAnswer;
    });
  }
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return harness;
}
