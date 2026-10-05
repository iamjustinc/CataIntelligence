/**
 * Calendar periods in a workspace's timezone, as half-open UTC intervals [start, end) (PRD ANA03).
 * No date library: the offset of a zone at an instant comes from Intl.
 */
export interface Interval {
  start: string;
  end: string;
}
interface Ymd {
  y: number;
  m: number;
  d: number;
}

function partsIn(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute, s: +parts.second };
}

/** The UTC instant at which the given calendar day starts in the zone. */
export function zonedMidnight({ y, m, d }: Ymd, timeZone: string): Date {
  const wall = Date.UTC(y, m - 1, d);
  let guess = wall;
  // Two passes settle the offset, including across a daylight-saving change.
  for (let i = 0; i < 2; i++) {
    const p = partsIn(new Date(guess), timeZone);
    guess += wall - Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  }
  return new Date(guess);
}

const addDays = ({ y, m, d }: Ymd, n: number): Ymd => {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const interval = (from: Ymd, to: Ymd, tz: string): Interval => ({ start: zonedMidnight(from, tz).toISOString(), end: zonedMidnight(to, tz).toISOString() });

export const PERIODS = ["today", "yesterday", "this_week", "last_week", "this_month", "last_month", "last_7_days", "last_30_days"] as const;
export type Period = (typeof PERIODS)[number];
export const PERIOD_LABELS: Record<Period, string> = { today: "Today", yesterday: "Yesterday", this_week: "This week", last_week: "Last week", this_month: "This month", last_month: "Last month", last_7_days: "Last 7 days", last_30_days: "Last 30 days" };

/** Weeks start on Monday, matching the UTC week grouping. "Last N days" ends at the end of today. */
export function periodInterval(period: Period, now: Date, timeZone: string): Interval {
  const p = partsIn(now, timeZone);
  const today: Ymd = { y: p.y, m: p.m, d: p.d };
  const weekday = (new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay() + 6) % 7; // Monday = 0
  const monday = addDays(today, -weekday);
  switch (period) {
    case "today": return interval(today, addDays(today, 1), timeZone);
    case "yesterday": return interval(addDays(today, -1), today, timeZone);
    case "this_week": return interval(monday, addDays(monday, 7), timeZone);
    case "last_week": return interval(addDays(monday, -7), monday, timeZone);
    case "this_month": return interval({ y: p.y, m: p.m, d: 1 }, addDays({ y: p.y, m: p.m + 1, d: 1 }, 0), timeZone);
    case "last_month": return interval(addDays({ y: p.y, m: p.m - 1, d: 1 }, 0), { y: p.y, m: p.m, d: 1 }, timeZone);
    case "last_7_days": return interval(addDays(today, -6), addDays(today, 1), timeZone);
    case "last_30_days": return interval(addDays(today, -29), addDays(today, 1), timeZone);
  }
}

/** A named calendar month of a stated year. */
export function monthInterval(year: number, month: number, timeZone: string): Interval {
  return interval({ y: year, m: month, d: 1 }, addDays({ y: year, m: month + 1, d: 1 }, 0), timeZone);
}

/** Inclusive calendar dates (YYYY-MM-DD) as a half-open interval ending after the last day. */
export function dateRangeInterval(from: string, to: string, timeZone: string): Interval | null {
  const parse = (v: string): Ymd | null => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
    if (!match) return null;
    const ymd = { y: +match[1], m: +match[2], d: +match[3] };
    const check = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d));
    return check.getUTCMonth() === ymd.m - 1 && check.getUTCDate() === ymd.d ? ymd : null;
  };
  const [a, b] = [parse(from), parse(to)];
  if (!a || !b || from > to) return null;
  return interval(a, addDays(b, 1), timeZone);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** "1 Sep 2026, 00:00" in the zone, for showing interpreted dates. */
export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
}
