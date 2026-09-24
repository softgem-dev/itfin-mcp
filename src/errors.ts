export type ErrorCode =
  | "AUTH_REQUIRED"
  | "DAY_CLOSED"
  | "DAY_IN_FUTURE"
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFIRMATION_DECLINED"
  | "CONFIRMATION_CANCELLED"
  | "CONFIRMATION_INVALID"
  | "ITFIN_ERROR";

export class ToolError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const TRACKING_NOT_ALLOWED = "Tracking is not allowed for this day.";
