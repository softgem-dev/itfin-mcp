import { DateTime } from "luxon";
import type { Config } from "./config.js";

export interface DayFlags {
  isHoliday: boolean;
  isWeekend: boolean;
}

/**
 * The relogin reminder: the start of working time on the last working day whose working time starts
 * before `deadline` (when the ITFin token stops being usable). If that moment has passed, it is due now.
 */
export function reloginReminderAt(opts: { deadline: Date; now: Date; config: Config; days: Map<string, DayFlags> }): Date | undefined {
  const { deadline: expiresAt, now, config, days } = opts;
  if (now >= expiresAt) return undefined;
  const [hour = 10, minute = 0] = config.workStart.split(":").map(Number);
  const today = DateTime.fromJSDate(now, { zone: config.timezone }).startOf("day");
  for (let day = DateTime.fromJSDate(expiresAt, { zone: config.timezone }).startOf("day"); day >= today; day = day.minus({ days: 1 })) {
    const start = day.set({ hour, minute });
    if (start.toJSDate() >= expiresAt || !isWorkingDay(day, days)) continue;
    return start.toJSDate() > now ? start.toJSDate() : now;
  }
  return now;
}

export function isWorkingDay(day: DateTime, days: Map<string, DayFlags>): boolean {
  const flags = days.get(day.toISODate()!);
  if (!flags) return day.weekday < 6;
  return !flags.isHoliday && !flags.isWeekend;
}

export function todayIn(now: Date, timezone: string): string {
  return DateTime.fromJSDate(now, { zone: timezone }).toISODate()!;
}
