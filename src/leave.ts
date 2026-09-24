// Leave requests (vacation, sick leave, paid and unpaid leave), mirroring ITFin's "Request time off" form.

/** A leave type from `GET /v3/timeoff-types/available/:date/:employeeId`. */
export interface RawLeaveType {
  id: number;
  name: string;
  /** Paid | Unpaid | CarryOver */
  type?: string;
  /** Vacation | Sickness | Unpaid | PaidLeave | CarryOver; ITFin's request type for this leave type. */
  oldSystemTimeoffName?: string | null;
  [key: string]: unknown;
}

/** ITFin's `POST /v3/timeoff/request-info` answer for a planned request. */
export interface RawLeaveRequestInfo {
  isAvailableToRequest?: boolean;
  isAttachFileToRequest?: boolean;
  /** null: unlimited */
  availableDays?: number | null;
  requestedDays?: number;
  minDays?: number;
  [key: string]: unknown;
}

export interface RawLeaveRequest {
  Id: number;
  RequestType: string;
  DateFrom: string;
  DateTo: string;
  Status: string;
  Reason?: string | null;
  Comment?: string | null;
  CreatedAt?: string;
  [key: string]: unknown;
}

/** Request types the web app shows as leave (`loadMyVacationsForPeriod`). */
export const LEAVE_REQUEST_TYPES = ["Vacation", "Sickness", "Unpaid", "PaidLeave", "CarryOver"];

/** Statuses after which a request can no longer be cancelled. */
export const CLOSED_REQUEST_STATUSES = ["Canceled", "Rejected"];

/** The web app's built-in reasons per request type. */
const BUILT_IN_REASONS: Record<string, string[]> = {
  Sickness: ["Airborne disease", "Trauma", "Mental health", "Poisoning, Gastrointestinal disorder", "Surgery, hospital stay", "Other"],
  Vacation: [
    "Rest and relax",
    "Improve physical health",
    "Increase mental power",
    "Improve well-being",
    "Decreased burnout",
    "Maternity leave",
    "Child rearing leave",
    "Other",
  ],
  PaidLeave: ["Birthday", "Wedding", "Death of relative", "Force majeure", "Personal circumstances", "Other"],
};

/** Workspace settings holding extra reasons, one per line; a leading "-" line replaces the built-in ones. */
export const ADDITIONAL_REASONS_SETTING: Record<string, string> = {
  Vacation: "AdditionalVacationLeaveReasons",
  Sickness: "AdditionalSicknessReasons",
  PaidLeave: "AdditionalPaidLeaveReasons",
};

/** The reasons the web app offers for a leave type; an empty list means the form has no reason field. */
export function leaveReasons(requestType: string | null | undefined, additional: unknown): string[] {
  const builtIn = BUILT_IN_REASONS[requestType ?? ""] ?? [];
  const extra = typeof additional === "string" ? additional.split("\n").map((r) => r.trim()).filter(Boolean) : [];
  if (extra[0] === "-") return extra.filter((r) => r !== "-");
  return [...builtIn, ...extra];
}

export function toLeaveRequest(r: RawLeaveRequest) {
  return {
    id: r.Id,
    type: r.RequestType,
    from: r.DateFrom.slice(0, 10),
    to: r.DateTo.slice(0, 10),
    status: r.Status,
    reason: r.Reason ?? undefined,
    comment: r.Comment ?? undefined,
    createdAt: r.CreatedAt,
  };
}
