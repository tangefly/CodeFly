/**
 * Calendar helpers for the schedule planner. Dates are plain `YYYY-MM-DD`
 * strings and clocks are `HH:mm`, so planning is independent of the server's
 * wall clock and DST transitions. `todayInTimezone` is the only place that
 * consults the user's configured timezone.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const MINUTES_PER_DAY = 24 * 60;

export function isValidDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const parsed = parseDate(value);
  return formatDate(parsed) === value;
}

export function isValidClock(value: string): boolean {
  return CLOCK_RE.test(value);
}

/** Parses a date at UTC noon so date arithmetic never crosses a DST boundary. */
export function parseDate(value: string): Date {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1, 12));
}

export function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(value: string, days: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatDate(date);
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function weekdayOf(value: string): number {
  const day = parseDate(value).getUTCDay();
  return day === 0 ? 7 : day;
}

export function mondayOf(value: string): string {
  return addDays(value, -(weekdayOf(value) - 1));
}

export function weekEndOf(weekStart: string): string {
  return addDays(weekStart, 6);
}

/** Last day of a rolling `days`-day window that starts at `start` (inclusive). */
export function rangeEndOf(start: string, days: number): string {
  return addDays(start, Math.max(0, days - 1));
}

/** Rounds a minute-of-day value up to the next `step` boundary. */
export function ceilMinutes(minutes: number, step = 5): number {
  return Math.ceil(minutes / step) * step;
}

export function compareDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function minDate(left: string, right: string): string {
  return compareDates(left, right) <= 0 ? left : right;
}

export function maxDate(left: string, right: string): string {
  return compareDates(left, right) >= 0 ? left : right;
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (parseDate(to).getTime() - parseDate(from).getTime()) / 86_400_000,
  );
}

export function clockToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
}

export function minutesToClock(total: number): string {
  const normalized = ((total % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function durationMinutes(start: string, end: string): number {
  return clockToMinutes(end) - clockToMinutes(start);
}

/** The local calendar date in `timezone`, falling back to the server zone. */
export function todayInTimezone(timezone: string | undefined): string {
  const zone = timezone?.trim() !== "" ? timezone : undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const lookup = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const value = `${lookup("year")}-${lookup("month")}-${lookup("day")}`;
    if (isValidDate(value)) return value;
  } catch {
    // Unknown timezone; use the server's local calendar date below.
  }
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Minutes since local midnight in `timezone`, falling back to the server zone. */
export function nowMinutesInTimezone(timezone: string | undefined): number {
  const zone = timezone?.trim() !== "" ? timezone : undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date());
    const lookup = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    const hours = Number(lookup("hour"));
    const minutes = Number(lookup("minute"));
    if (Number.isFinite(hours) && Number.isFinite(minutes)) {
      return (hours % 24) * 60 + minutes;
    }
  } catch {
    // Unknown timezone; use the server's local clock below.
  }
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

/** Local wall-clock HH:mm in `timezone`. */
export function nowClockInTimezone(timezone: string | undefined): string {
  return minutesToClock(nowMinutesInTimezone(timezone));
}

/**
 * Formats an ISO timestamp as `YYYY-MM-DD HH:mm` in the user's timezone.
 * ISO strings are stored in UTC, so rendering them directly would show UTC
 * instead of the wall-clock time the user actually sees.
 */
export function formatDateTimeInTimezone(
  iso: string,
  timezone: string | undefined,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const zone = timezone?.trim() !== "" ? timezone : undefined;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(date);
    const lookup = (type: string): string =>
      parts.find((part) => part.type === type)?.value ?? "";
    return `${lookup("year")}-${lookup("month")}-${lookup("day")} ${lookup(
      "hour",
    )}:${lookup("minute")}`;
  } catch {
    // Unknown timezone; fall back to the server's local wall clock.
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }
}

export function serverTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

export function weekdayLabel(value: string): string {
  return WEEKDAY_LABELS[weekdayOf(value) - 1] ?? "";
}

export function weekLabel(weekStart: string): string {
  return `${weekStart} ~ ${addDays(weekStart, 6)}`;
}
