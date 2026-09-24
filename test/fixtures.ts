// ITFin response shapes recorded from a live workspace on 2026-09-24, scrubbed of personal data.
import { DateTime } from "luxon";

export interface DayOverrides {
  isEditable?: boolean;
  isHoliday?: boolean;
  isWeekend?: boolean;
  log?: unknown[];
}

export function logEntry(o: { id: number; date: string; minutes: number; comment: string; clientAgreementId?: number; projectId?: number; projectName?: string; taskId?: number | null }) {
  return {
    Date: o.date,
    Id: o.id,
    MinutesInt: o.minutes,
    MinutesExt: o.minutes,
    InternalTime: String(o.minutes / 60),
    ExternalTime: "",
    EmployeeId: 1001,
    ReviewedBy: null,
    Approved: null,
    DeclineReason: null,
    TaskId: o.taskId ?? null,
    ClientAgreementId: o.clientAgreementId ?? 5001,
    Comment: o.comment,
    ExternalTool: null,
    TaskReference: null,
    Type: "Work",
    Reason: null,
    RequestId: null,
    CreatedAt: `${o.date}T12:00:00.000Z`,
    ProjectName: o.projectName ?? "Alpha",
    IsBillableProject: true,
    ProjectId: o.projectId ?? 301,
    IsCanEditOrApprove: true,
  };
}

/**
 * GET /v1/tracking response for [from, to]. Weekends are flagged automatically; by default days before
 * `today` in a previous ISO week and days after `today` are not editable, like the live workspace.
 */
export function trackingResponse(from: string, to: string, opts: { today: string; days?: Record<string, DayOverrides> }) {
  const data = [];
  const today = DateTime.fromISO(opts.today);
  for (let d = DateTime.fromISO(from); d <= DateTime.fromISO(to); d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    const o = opts.days?.[date] ?? {};
    const isWeekend = o.isWeekend ?? d.weekday >= 6;
    const sameWeek = d.startOf("week").equals(today.startOf("week"));
    const defaultEditable = d <= today && sameWeek && !isWeekend;
    const log = o.log ?? [];
    const minutes = (log as { MinutesInt: number }[]).reduce((s, e) => s + e.MinutesInt, 0);
    data.push({
      Date: date,
      isEditable: o.isEditable ?? defaultEditable,
      isCanTrackTimeoff: true,
      isHoliday: o.isHoliday ?? false,
      isWeekend,
      isWFH: false,
      MinutesInt: minutes,
      MinutesExt: minutes,
      log,
      BusinessHours: 8,
    });
  }
  return {
    agreements: [{ Project: { Id: 301, Name: "Alpha" }, OvertimeWeeklyLimit: 0, OvertimeUsedMinutes: 0, UsedMinutes: 0, WeeklyLimit: 1440 }],
    data,
  };
}

/** Serves GET /v1/tracking for whatever range is asked, using the given day overrides. */
export function trackingRoute(opts: { today: string; days?: Record<string, DayOverrides> }) {
  return (req: { query: Record<string, string> }) => ({
    body: trackingResponse(req.query["filter[from]"]!, req.query["filter[to]"]!, opts),
  });
}

export const me = { Id: 1001, OwnerId: 2, Email: "test.user@example.com", FirstName: "Test", LastName: "User", TimeZone: "Europe/Kyiv" };

export const workspace = {
  Settings: { TrackingMinCommentLength: 10, OpenReportingApprovals: { Enabled: true } },
};

export const projectsForDate = [
  {
    WithScopeOfWork: 0,
    IsTaskReference: 0,
    BoardId: 257,
    ProjectId: 301,
    ProjectName: "Alpha",
    IsAllowTrackExternal: 0,
    ClientAgreementId: 5001,
    agreements: [
      { DateStart: "2026-09-01T00:00:00.000Z", DateEnd: "2026-12-31T00:00:00.000Z", Id: 5001, ProjectId: 301, EmployeeId: 1001, AgreementType: "Hourly", Type: "NotBillable", Basis: "Hourly", Status: "Active" },
    ],
    tasks: [{ Id: 71, Name: "Code review" }],
  },
];

export function reopenRequest(o: { id: number; from: string; to: string; status: string; comment?: string }) {
  return { DateFrom: o.from, DateTo: o.to, CreatedAt: "2026-09-01T08:00:00.000Z", UpdatedAt: "2026-09-01T08:00:00.000Z", Id: o.id, RequestType: "OpenReporting", Status: o.status, Comment: o.comment ?? "Forgot to report last week" };
}
