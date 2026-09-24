import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Clock } from "./clock.js";
import type { Config } from "./config.js";
import { ToolError } from "./errors.js";
import { ItfinClient } from "./itfinClient.js";
import { startBrowserLogin, type LoginSession } from "./login.js";
import { LaunchdReminderScheduler, type ReminderScheduler } from "./reminders.js";
import { decodeToken } from "./jwt.js";
import type { TokenStore } from "./tokenStore.js";
import { reloginReminderAt, todayIn, type DayFlags } from "./workingTime.js";

/** A token this close to expiry is treated as expired, to absorb clock skew. */
export const EXPIRY_SKEW_MS = 5 * 60 * 1000;

export interface ServerDeps {
  config: Config;
  clock: Clock;
  tokenStore: TokenStore;
  /** Base delay between retries of network errors and 5xx responses. */
  retryDelayMs?: number;
  /** Opens the login browser; defaults to the configured Chromium-based browser. */
  startLogin?: (maxWaitMs: number) => Promise<LoginSession>;
  reminders?: ReminderScheduler;
  /** A confirmation-form answer faster than this means the app never showed the form. */
  instantAnswerMs?: number;
}

/** How long itfin_login blocks before it keeps waiting in the background. */
const LOGIN_BLOCK_MS = 3 * 60 * 1000;
/** How long the login browser stays open waiting for the user. */
const LOGIN_MAX_WAIT_MS = 15 * 60 * 1000;

interface RawEntry {
  Id: number;
  Date: string;
  ProjectId: number;
  ProjectName: string;
  ClientAgreementId: number;
  TaskId: number | null;
  MinutesInt: number;
  Comment: string;
  Type: string;
  Approved: boolean | null;
  [key: string]: unknown;
}

interface RawDay {
  Date: string;
  isEditable: boolean;
  isHoliday: boolean;
  isWeekend: boolean;
  BusinessHours: number;
  log: RawEntry[];
}

interface RawProject {
  ProjectId: number;
  ProjectName: string;
  ClientAgreementId: number;
  agreements?: { Id: number; Type?: string }[];
  tasks?: { Id: number; Name?: string; Title?: string }[];
}

/** open: reportable; closed: today or earlier and no longer reportable; future: not reportable yet. */
export type DayStatus = "open" | "closed" | "future";

interface RawReopenRequest {
  Id: number;
  DateFrom: string;
  DateTo: string;
  Status: string;
  Comment?: string;
  CreatedAt?: string;
}

const REOPEN_REASON_MIN = 10;
/** How long a chat-confirmation token for a reopen request stays valid. */
const CONFIRMATION_TOKEN_TTL_MS = 10 * 60 * 1000;

const REOPEN_HINT =
  "The reporting period for these days is closed. With the user's explicit agreement you can file a reopen request (itfin_request_reopen); a manager must approve it.";

/** How the agent fills in the reason when the user didn't give one. */
const REOPEN_REASON_HINT =
  "Reason shown to the manager, at least 10 characters. If the user didn't give one, invent a short, funny but workplace-safe excuse " +
  "(one or two sentences, in the user's language, a fresh one every time, no blaming colleagues or real people). The user sees it in the preview before anything is filed.";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

function toReopenRequest(r: RawReopenRequest) {
  return { id: r.Id, from: r.DateFrom.slice(0, 10), to: r.DateTo.slice(0, 10), status: r.Status, comment: r.Comment, createdAt: r.CreatedAt };
}

/** Finds a setting by key anywhere in the workspace settings payload. */
function findSetting(obj: unknown, key: string): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  if (key in obj) return (obj as Record<string, unknown>)[key];
  for (const v of Object.values(obj)) {
    const found = findSetting(v, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** When an ITFin token stops being usable: its expiry minus the clock-skew margin. */
function usableUntil(expiresAt: Date): Date {
  return new Date(expiresAt.getTime() - EXPIRY_SKEW_MS);
}

/** ITFin keeps a time entry's duration both as minutes and as decimal hours. */
function duration(minutes: number) {
  return { MinutesInt: minutes, InternalTime: String(minutes / 60) };
}

function toEntry(e: RawEntry) {
  return {
    id: e.Id,
    date: e.Date,
    projectId: e.ProjectId,
    projectName: e.ProjectName,
    clientAgreementId: e.ClientAgreementId,
    taskId: e.TaskId,
    minutes: e.MinutesInt,
    comment: e.Comment,
    type: e.Type,
    approved: e.Approved,
  };
}

export function createItfinServer(deps: ServerDeps): McpServer {
  const { config, clock, tokenStore } = deps;
  const instantAnswerMs = deps.instantAnswerMs ?? 1000;
  const server = new McpServer({ name: "itfin-mcp", version: "0.1.0" });

  type TokenState =
    | { valid: true; token: string; email?: string; expiresAt: Date }
    | { valid: false; reason: "no_token" | "malformed" | "rejected" | "expired"; email?: string; expiresAt?: Date };

  /** The stored ITFin token and whether it can still be used. */
  async function tokenState(): Promise<TokenState> {
    const stored = await tokenStore.load();
    if (!stored) return { valid: false, reason: "no_token" };
    let claims;
    try {
      claims = decodeToken(stored.token);
    } catch {
      return { valid: false, reason: "malformed" };
    }
    const info = { email: claims.Email, expiresAt: new Date(claims.exp * 1000) };
    if (stored.rejected) return { valid: false, reason: "rejected", ...info };
    if (usableUntil(info.expiresAt) <= clock.now()) return { valid: false, reason: "expired", ...info };
    return { valid: true, token: stored.token, ...info };
  }

  async function validToken(): Promise<string> {
    const state = await tokenState();
    if (state.valid) return state.token;
    const why = { no_token: "No ITFin token.", malformed: "The stored ITFin token is unreadable.", rejected: "ITFin rejected the ITFin token.", expired: "The ITFin token has expired." }[state.reason];
    throw new ToolError("AUTH_REQUIRED", `${why} Ask the user to log in (itfin_login).`, { expiresAt: state.expiresAt?.toISOString() });
  }

  async function markRejected(token: string): Promise<void> {
    const stored = await tokenStore.load();
    if (stored?.token === token) await tokenStore.save(token, { ...stored, rejected: true });
  }

  const itfin = new ItfinClient(config.workspaceUrl, validToken, deps.retryDelayMs ?? 500, markRejected);
  const reminders = deps.reminders ?? new LaunchdReminderScheduler();
  const startLogin =
    deps.startLogin ?? ((maxWaitMs: number) => startBrowserLogin({ workspaceUrl: config.workspaceUrl, browser: config.browser, maxWaitMs }));
  let loginInProgress: Promise<LoginResult> | undefined;

  interface LoginResult {
    email?: string;
    expiresAt: string;
    nextReminderAt?: string;
  }

  /** Stores a freshly issued ITFin token and replaces the relogin reminder. */
  async function completeLogin(token: string): Promise<LoginResult> {
    const claims = decodeToken(token);
    const expiresAt = new Date(claims.exp * 1000);
    await tokenStore.save(token);
    const reminder = await nextReminder(expiresAt, clock.now());
    if (reminder) await reminders.schedule(reminder, config.workspaceUrl);
    return { email: claims.Email, expiresAt: expiresAt.toISOString(), nextReminderAt: reminder?.toISOString() };
  }

  async function getDays(from: string, to: string): Promise<RawDay[]> {
    const res = await itfin.get<{ data: RawDay[] }>("/v1/tracking", { includes: "log", "filter[from]": from, "filter[to]": to });
    return res.data;
  }

  async function getDay(date: string): Promise<RawDay> {
    const [day] = await getDays(date, date);
    if (!day) throw new ToolError("ITFIN_ERROR", `ITFin returned no data for ${date}.`);
    return day;
  }

  async function workspaceSettings(): Promise<{ minCommentLength: number; reopenRequestsEnabled: boolean }> {
    const host = new URL(config.workspaceUrl).host;
    const raw = await itfin.request<unknown>("GET", `/v1/auth/workspaces/${host}`, { anonymous: true });
    const reopen = findSetting(raw, "OpenReportingApprovals") as { Enabled?: boolean } | undefined;
    return {
      minCommentLength: Number(findSetting(raw, "TrackingMinCommentLength") ?? 0),
      reopenRequestsEnabled: Boolean(reopen?.Enabled),
    };
  }

  async function employeeId(): Promise<number> {
    const stored = await tokenStore.load();
    if (stored?.employeeId) return stored.employeeId;
    const me = await itfin.get<{ Id: number }>("/v1/auth");
    if (stored) await tokenStore.save(stored.token, { ...stored, employeeId: me.Id });
    return me.Id;
  }

  async function reopenRequests(): Promise<RawReopenRequest[]> {
    return itfin.get<RawReopenRequest[]>("/v1/requests/my", { "filter[requestType]": "OpenReporting", page: 1, size: 50 });
  }

  async function reopenRequestsCovering(date: string) {
    return (await reopenRequests()).map(toReopenRequest).filter((r) => r.from <= date && date <= r.to);
  }

  async function closedDayError(date: string, message = "Reporting is closed for this day."): Promise<ToolError> {
    const covering = await reopenRequestsCovering(date).catch(() => []);
    return new ToolError("DAY_CLOSED", message, { closedDates: [date], reopenRequests: covering, hint: REOPEN_HINT });
  }

  /** Throws unless time entries on `date` can be written; an approved reopen request lets ITFin decide. */
  async function assertReportable(date: string, day?: RawDay): Promise<void> {
    const status = dayStatus(day ?? (await getDay(date)));
    if (status === "open") return;
    if (status === "future") throw new ToolError("DAY_IN_FUTURE", `${date} is not reportable yet.`);
    const approved = (await reopenRequestsCovering(date)).some((r) => r.status === "Approved");
    if (!approved) throw await closedDayError(date);
  }

  async function assertComment(comment: string): Promise<void> {
    const { minCommentLength } = await workspaceSettings();
    if (comment.trim().length < minCommentLength) {
      throw new ToolError("VALIDATION", `The comment must be at least ${minCommentLength} characters.`, { minCommentLength });
    }
  }

  /** Runs a write, turning ITFin's closed-day rejection into a DAY_CLOSED error with details. */
  async function withClosedDayDetails<T>(date: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof ToolError && err.code === "DAY_CLOSED" && !err.details.closedDates) throw await closedDayError(date, err.message);
      throw err;
    }
  }

  async function findEntry(id: number, date: string): Promise<{ day: RawDay; entry: RawEntry }> {
    const day = await getDay(date);
    const entry = day.log.find((e) => e.Id === id);
    if (!entry) throw new ToolError("NOT_FOUND", `No time entry ${id} on ${date}.`);
    return { day, entry };
  }

  function dayStatus(day: RawDay): DayStatus {
    if (day.isEditable) return "open";
    return day.Date < todayIn(clock.now(), config.timezone) ? "closed" : "future";
  }

  server.registerTool(
    "itfin_get_entries",
    {
      title: "Read time entries",
      description:
        "Time entries for a date range (inclusive), grouped by day. Use one day, a week or a month as the range. Each day has a status: open (reportable), closed (reporting period closed; needs a reopen request) or future (not reportable yet).",
      inputSchema: { from: isoDate, to: isoDate },
      annotations: { readOnlyHint: true },
    },
    ({ from, to }) =>
      handle(async () => {
        if (to < from) throw new ToolError("VALIDATION", "`to` must not be before `from`.");
        const days = await getDays(from, to);
        return {
          days: days.map((d) => ({
            date: d.Date,
            status: dayStatus(d),
            isHoliday: d.isHoliday,
            isWeekend: d.isWeekend,
            businessHours: d.BusinessHours,
            totalMinutes: d.log.reduce((sum, e) => sum + e.MinutesInt, 0),
            entries: d.log.map(toEntry),
          })),
        };
      }),
  );

  server.registerTool(
    "itfin_list_projects",
    {
      title: "List reportable projects",
      description:
        "Projects the user can report time to on a given date, with the clientAgreementId needed to create a time entry and the project's tasks. The list depends on the date.",
      inputSchema: { date: isoDate },
      annotations: { readOnlyHint: true },
    },
    ({ date }) =>
      handle(async () => {
        const projects = await itfin.get<RawProject[]>("/v1/tracking/tasks", { Date: date, name: "" });
        return {
          projects: projects.map((p) => ({
            projectId: p.ProjectId,
            projectName: p.ProjectName,
            clientAgreementId: p.ClientAgreementId,
            billable: p.agreements?.find((a) => a.Id === p.ClientAgreementId)?.Type !== "NotBillable",
            tasks: (p.tasks ?? []).map((t) => ({ id: t.Id, name: t.Name ?? t.Title ?? "" })),
          })),
        };
      }),
  );

  type ReopenRequestInput = { from: string; to: string; reason: string };
  const pendingConfirmations = new Map<string, { request: ReopenRequestInput; expiresAt: number }>();

  async function fileReopenRequest(request: ReopenRequestInput) {
    const body = { RequestType: "OpenReporting", EmployeeId: await employeeId(), DateFrom: request.from, DateTo: request.to, Comment: request.reason };
    const res = await itfin.request<{ Id?: number } | undefined>("POST", "/v1/requests/open-reporting", { body });
    return { requested: true, id: res?.Id };
  }

  /**
   * Asks the user through the app's confirmation form. Returns "unavailable" when the app can't show
   * forms, or answers faster than a person could (it advertised forms but never showed one).
   */
  async function confirmWithForm(request: ReopenRequestInput): Promise<"confirmed" | "unavailable"> {
    if (!server.server.getClientCapabilities()?.elicitation) return "unavailable";
    const started = performance.now();
    let answer;
    try {
      answer = await server.server.elicitInput({
        message: `File an ITFin reopen request for ${request.from} – ${request.to}? Your manager will be asked to approve it.\nReason: ${request.reason}`,
        requestedSchema: {
          type: "object",
          properties: { confirm: { type: "boolean", title: "Send the reopen request", default: true } },
        },
      });
    } catch (err) {
      console.error(`[itfin-mcp] confirmation form failed: ${(err as Error).message}`);
      return "unavailable";
    }
    const elicitation = {
      action: answer.action,
      confirm: answer.content?.confirm,
      elapsedMs: Math.round(performance.now() - started),
    };
    console.error(`[itfin-mcp] reopen confirmation: ${JSON.stringify(elicitation)}`);
    // No person answers this fast: the app replied without showing the form, so its answer (even an
    // accept) is not the user's consent.
    if (elicitation.elapsedMs < instantAnswerMs) return "unavailable";
    if (answer.action === "accept" && answer.content?.confirm !== false) return "confirmed";
    if (answer.action === "cancel") {
      throw new ToolError("CONFIRMATION_CANCELLED", "The user dismissed the confirmation. Nothing was filed.", { elicitation });
    }
    throw new ToolError("CONFIRMATION_DECLINED", "The user did not confirm the reopen request. Nothing was filed.", { elicitation });
  }

  function issueConfirmationToken(request: ReopenRequestInput) {
    const now = clock.now().getTime();
    for (const [token, p] of pendingConfirmations) if (p.expiresAt <= now) pendingConfirmations.delete(token);
    const confirmationToken = randomUUID();
    const expiresAt = now + CONFIRMATION_TOKEN_TTL_MS;
    pendingConfirmations.set(confirmationToken, { request, expiresAt });
    return {
      requested: false,
      needsUserConfirmation: true,
      preview: request,
      confirmationToken,
      confirmationExpiresAt: new Date(expiresAt).toISOString(),
      instructions:
        "Nothing was filed. Show the preview to the user and ask whether to send it to their manager. Only if they explicitly agree, call itfin_request_reopen again with the same from, to, reason and this confirmationToken.",
    };
  }

  function redeemConfirmationToken(token: string, request: ReopenRequestInput): void {
    const pending = pendingConfirmations.get(token);
    pendingConfirmations.delete(token);
    const matches =
      pending &&
      pending.expiresAt > clock.now().getTime() &&
      pending.request.from === request.from &&
      pending.request.to === request.to &&
      pending.request.reason === request.reason;
    if (!matches) {
      throw new ToolError(
        "CONFIRMATION_INVALID",
        "The confirmation token is unknown, expired, already used, or was issued for different dates or reason. Call without a token to get a new one.",
      );
    }
  }

  server.registerTool(
    "itfin_create_entry",
    {
      title: "Create a time entry",
      description:
        "Creates a time entry for the logged-in user. Get clientAgreementId and taskId from itfin_list_projects for the same date. Fails with DAY_CLOSED or DAY_IN_FUTURE when the day is not reportable, and with VALIDATION when the comment is shorter than the workspace minimum.",
      inputSchema: {
        date: isoDate,
        clientAgreementId: z.number().int(),
        minutes: z.number().int().positive(),
        comment: z.string(),
        taskId: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    (args) =>
      handle(async () => {
        await assertComment(args.comment);
        await assertReportable(args.date);
        const body = {
          EmployeeId: await employeeId(),
          Date: args.date,
          ClientAgreementId: args.clientAgreementId,
          TaskId: args.taskId ?? null,
          TaskReference: null,
          ...duration(args.minutes),
          Comment: args.comment,
          IsNonBillable: false,
        };
        const res = await withClosedDayDetails(args.date, () => itfin.request<{ Id: number }>("POST", "/v1/tracking", { body }));
        return { id: res.Id };
      }),
  );

  server.registerTool(
    "itfin_update_entry",
    {
      title: "Update a time entry",
      description:
        "Changes a time entry. Pass its id and current date (from itfin_get_entries) and only the fields to change; use newDate to move it to another day. Both days must be reportable.",
      inputSchema: {
        id: z.number().int(),
        date: isoDate,
        newDate: isoDate.optional(),
        clientAgreementId: z.number().int().optional(),
        taskId: z.number().int().nullable().optional(),
        minutes: z.number().int().positive().optional(),
        comment: z.string().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      handle(async () => {
        const { day, entry } = await findEntry(args.id, args.date);
        await assertReportable(args.date, day);
        if (args.newDate && args.newDate !== args.date) await assertReportable(args.newDate);
        if (args.comment !== undefined) await assertComment(args.comment);
        const minutes = args.minutes ?? entry.MinutesInt;
        // Like the web app: send the whole entry minus the integration fields.
        const { ExternalId: _id, ExternalTool: _tool, ...entryFields } = entry;
        const rest: Record<string, unknown> = entryFields;
        const agreementChanged = args.clientAgreementId !== undefined && args.clientAgreementId !== entry.ClientAgreementId;
        if (agreementChanged) {
          // Project fields describe the old agreement; ITFin derives them from ClientAgreementId.
          delete rest.ProjectId;
          delete rest.ProjectName;
        }
        const body = {
          ...rest,
          Date: args.newDate ?? entry.Date,
          ClientAgreementId: args.clientAgreementId ?? entry.ClientAgreementId,
          TaskId: args.taskId === undefined ? entry.TaskId : args.taskId,
          ...duration(minutes),
          Comment: args.comment ?? entry.Comment,
          IsNonBillable: !entry.MinutesExt,
        };
        const res = await withClosedDayDetails(body.Date, () => itfin.request<{ Id: number }>("PUT", `/v1/tracking/${args.id}`, { body }));
        return { id: res.Id };
      }),
  );

  server.registerTool(
    "itfin_delete_entry",
    {
      title: "Delete a time entry",
      description: "Deletes a time entry by id. Pass its date (from itfin_get_entries); the day must be reportable.",
      inputSchema: { id: z.number().int(), date: isoDate },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    (args) =>
      handle(async () => {
        const { day } = await findEntry(args.id, args.date);
        await assertReportable(args.date, day);
        await withClosedDayDetails(args.date, () => itfin.request("DELETE", `/v1/tracking/${args.id}`));
        return { deleted: args.id };
      }),
  );

  server.registerTool(
    "itfin_get_workspace_settings",
    {
      title: "Workspace settings",
      description: "ITFin workspace rules for time entries: the minimum comment length and whether reopen requests are enabled.",
      annotations: { readOnlyHint: true },
    },
    () =>
      handle(async () => {
        const { minCommentLength, reopenRequestsEnabled } = await workspaceSettings();
        return { minCommentLength, reopenRequestsEnabled };
      }),
  );

  server.registerTool(
    "itfin_list_reopen_requests",
    {
      title: "List reopen requests",
      description: "The user's reopen requests for closed days and their status (e.g. Pending, Approved, Declined).",
      annotations: { readOnlyHint: true },
    },
    () => handle(async () => ({ requests: (await reopenRequests()).map(toReopenRequest) })),
  );

  server.registerTool(
    "itfin_request_reopen",
    {
      title: "Request to reopen closed days",
      description:
        "Files a reopen request asking a manager to allow reporting on closed days. Only call this after the user has explicitly agreed in the conversation. " +
        "If the app can show a confirmation form, the user confirms there and the request is filed. Otherwise the result has needsUserConfirmation, a preview and a confirmationToken: " +
        "show the preview to the user, and only if they explicitly agree, call again with the same from, to, reason and the confirmationToken (valid 10 minutes, single use). " +
        "If the user didn't say why, make up a funny excuse for the reason yourself instead of asking.",
      inputSchema: { from: isoDate, to: isoDate, reason: z.string().describe(REOPEN_REASON_HINT), confirmationToken: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    (args) =>
      handle(async () => {
        if (args.to < args.from) throw new ToolError("VALIDATION", "`to` must not be before `from`.");
        if (args.reason.trim().length < REOPEN_REASON_MIN) {
          throw new ToolError("VALIDATION", `The reason must be at least ${REOPEN_REASON_MIN} characters.`);
        }
        if (!(await workspaceSettings()).reopenRequestsEnabled) {
          throw new ToolError("VALIDATION", "Reopen requests are disabled in this ITFin workspace.");
        }
        const request = { from: args.from, to: args.to, reason: args.reason };
        if (args.confirmationToken !== undefined) {
          redeemConfirmationToken(args.confirmationToken, request);
          return fileReopenRequest(request);
        }
        const confirmation = await confirmWithForm(request);
        if (confirmation === "confirmed") return fileReopenRequest(request);
        return issueConfirmationToken(request);
      }),
  );

  server.registerTool(
    "itfin_login",
    {
      title: "Log in to ITFin",
      description:
        "Opens a browser window on the ITFin workspace so the user can sign in with Google, then stores the new ITFin token (valid 7 days) and schedules a relogin reminder. Call it only when the user asks to log in. Waits up to 3 minutes; if the user is slower, it keeps waiting in the background and shows a notification on success.",
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    () =>
      handle(async () => {
        if (!loginInProgress) {
          const session = await startLogin(LOGIN_MAX_WAIT_MS);
          loginInProgress = session.token.then(completeLogin).finally(() => {
            loginInProgress = undefined;
          });
        }
        const pending = loginInProgress;
        const timeout = new Promise<"waiting">((r) => setTimeout(() => r("waiting"), LOGIN_BLOCK_MS).unref());
        const result = await Promise.race([pending, timeout]);
        if (result === "waiting") {
          pending.then(
            () => reminders.notify("ITFin", "Logged in to ITFin."),
            (err: Error) => reminders.notify("ITFin", `Login failed: ${err.message}`),
          );
          return { status: "waiting", message: "The login window is still open. The user will get a notification once they have signed in." };
        }
        return { status: "logged_in", ...result };
      }),
  );

  server.registerTool(
    "itfin_auth_status",
    {
      title: "ITFin token status",
      description:
        "Whether a valid ITFin token is stored, when it expires, and when the relogin reminder is due. Use it to warn the user before the token expires.",
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () =>
      handle(async () => {
        const state = await tokenState();
        const base = { email: state.email, expiresAt: state.expiresAt?.toISOString() };
        if (!state.valid) return { valid: false, reason: state.reason, ...base };
        const reminder = await nextReminder(state.expiresAt, clock.now());
        return { valid: true, ...base, nextReminderAt: reminder?.toISOString() };
      }),
  );

  /** Computes the relogin reminder, taking holidays and weekends from ITFin when it can. */
  async function nextReminder(expiresAt: Date, now: Date): Promise<Date | undefined> {
    const days = new Map<string, DayFlags>();
    try {
      for (const d of await getDays(todayIn(now, config.timezone), todayIn(expiresAt, config.timezone))) days.set(d.Date, { isHoliday: d.isHoliday, isWeekend: d.isWeekend });
    } catch {
      // Fall back to Monday–Friday.
    }
    return reloginReminderAt({ deadline: usableUntil(expiresAt), now, config, days });
  }

  return server;
}

async function handle(fn: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return { content: [{ type: "text", text: JSON.stringify(data ?? { ok: true }) }] };
  } catch (err) {
    const error =
      err instanceof ToolError
        ? { code: err.code, message: err.message, ...err.details }
        : { code: "INTERNAL", message: (err as Error).message };
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error }) }] };
  }
}
