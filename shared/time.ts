// DST-safe timezone helpers built on Intl only. Storage is always UTC; conversion happens at the edges.

export interface LocalDateTime {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of a UTC instant in `tz`. */
export function utcToLocal(utcMs: number, tz: string): LocalDateTime {
  const parts = formatterFor(tz).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour") % 24, minute: get("minute"), second: get("second") };
}

/** Offset of `tz` from UTC at the given instant, in ms (positive east of UTC). */
export function getOffsetMs(utcMs: number, tz: string): number {
  const l = utcToLocal(utcMs, tz);
  const asUtc = Date.UTC(l.year, l.month - 1, l.day, l.hour, l.minute, l.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `tz` to a UTC instant (ms).
 * - Ambiguous times (clocks fall back) resolve to the earlier occurrence.
 * - Non-existent times (clocks spring forward) resolve forward by the gap, e.g. 02:30 -> 03:30.
 */
export function localToUtc(local: LocalDateTime, tz: string): number {
  const guess = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  const candidates = new Set<number>();
  for (const probe of [guess - DAY_MS, guess + DAY_MS]) {
    candidates.add(guess - getOffsetMs(probe, tz));
  }
  const valid = [...candidates].filter((c) => guess - c === getOffsetMs(c, tz));
  if (valid.length > 0) return Math.min(...valid);
  // In a gap: interpret using the offset in force before the transition.
  return guess - getOffsetMs(guess - DAY_MS, tz);
}

export function localToUtcIso(local: LocalDateTime, tz: string): string {
  return new Date(localToUtc(local, tz)).toISOString();
}

export function utcIsoToLocal(iso: string, tz: string): LocalDateTime {
  return utcToLocal(Date.parse(iso), tz);
}

/** Calendar-day arithmetic on wall-clock fields (keeps the time of day, independent of DST). */
export function addLocalDays(local: LocalDateTime, days: number): LocalDateTime {
  const d = new Date(Date.UTC(local.year, local.month - 1, local.day + days, local.hour, local.minute, local.second));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: local.hour,
    minute: local.minute,
    second: local.second,
  };
}

/** Shifts a UTC instant by whole local calendar days in `tz`, preserving the local time of day. */
export function shiftUtcIsoByLocalDays(iso: string, days: number, tz: string): string {
  return localToUtcIso(addLocalDays(utcIsoToLocal(iso, tz), days), tz);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** 0 = Sunday ... 6 = Saturday for a calendar date. */
export function weekdayOf(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function localDateKey(l: Pick<LocalDateTime, "year" | "month" | "day">): string {
  return `${l.year}-${String(l.month).padStart(2, "0")}-${String(l.day).padStart(2, "0")}`;
}

export function startOfLocalDay(l: Pick<LocalDateTime, "year" | "month" | "day">): LocalDateTime {
  return { year: l.year, month: l.month, day: l.day, hour: 0, minute: 0, second: 0 };
}

/** Start of the week (Monday by default) containing the given date. */
export function startOfLocalWeek(l: Pick<LocalDateTime, "year" | "month" | "day">, weekStartsOn = 1): LocalDateTime {
  const diff = (weekdayOf(l.year, l.month, l.day) - weekStartsOn + 7) % 7;
  return addLocalDays(startOfLocalDay(l), -diff);
}

export interface CalendarRange {
  days: LocalDateTime[];
  fromUtc: string;
  /** Exclusive upper bound. */
  toUtc: string;
}

/** Whole weeks covering the month (a 6x7 or 5x7 grid) for week-starts-on-Monday layouts. */
export function monthGridRange(year: number, month: number, tz: string): CalendarRange {
  const first = startOfLocalWeek({ year, month, day: 1 });
  const last = startOfLocalWeek({ year, month, day: daysInMonth(year, month) });
  const weeks = Math.round((Date.UTC(last.year, last.month - 1, last.day) - Date.UTC(first.year, first.month - 1, first.day)) / DAY_MS / 7) + 1;
  return rangeFrom(first, weeks * 7, tz);
}

export function weekRange(anchor: Pick<LocalDateTime, "year" | "month" | "day">, tz: string): CalendarRange {
  return rangeFrom(startOfLocalWeek(anchor), 7, tz);
}

function rangeFrom(start: LocalDateTime, dayCount: number, tz: string): CalendarRange {
  const days: LocalDateTime[] = [];
  for (let i = 0; i < dayCount; i++) days.push(addLocalDays(start, i));
  return {
    days,
    fromUtc: localToUtcIso(days[0], tz),
    toUtc: localToUtcIso(addLocalDays(days[days.length - 1], 1), tz),
  };
}

/** Parses "YYYY-MM-DDTHH:mm" (datetime-local input value). Returns null if malformed. */
export function parseLocalInput(value: string): LocalDateTime | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!m) return null;
  const l = { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5], second: m[6] ? +m[6] : 0 };
  if (l.month < 1 || l.month > 12 || l.day < 1 || l.day > daysInMonth(l.year, l.month) || l.hour > 23 || l.minute > 59 || l.second > 59) return null;
  return l;
}

export function formatLocalInput(l: LocalDateTime): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${localDateKey(l)}T${p(l.hour)}:${p(l.minute)}`;
}
