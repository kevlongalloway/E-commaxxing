import type { DateRange, TimeseriesInterval } from "../types.js";

/**
 * Date-range helpers for the admin dashboard.
 *
 * Everything is stored in UTC (ISO 8601 strings), but a merchant thinks in
 * their own timezone — "today" means their local day, not 00:00 UTC. So every
 * range is resolved against a timezone offset supplied by the caller
 * (`tz_offset_minutes`, e.g. -420 for UTC-07:00), which the frontend can read
 * from `-new Date().getTimezoneOffset()`.
 *
 * All ranges are half-open: [start, end).
 */

export type RangePreset =
  | "today"
  | "yesterday"
  | "7d"
  | "30d"
  | "90d"
  | "12m"
  | "mtd"
  | "last_month"
  | "ytd"
  | "all"
  | "custom";

export const RANGE_PRESETS: RangePreset[] = [
  "today",
  "yesterday",
  "7d",
  "30d",
  "90d",
  "12m",
  "mtd",
  "last_month",
  "ytd",
  "all",
  "custom",
];

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** Hard cap on chart points, so an hourly range over a year can't blow up. */
const MAX_BUCKETS = 800;

// ─── Timezone shifting ────────────────────────────────────────────────────────

/**
 * Shifts an instant so that its UTC getters read as local wall-clock time.
 * Always paired with `unshift` to get back to a real instant.
 */
function shift(instant: Date, tzOffsetMinutes: number): Date {
  return new Date(instant.getTime() + tzOffsetMinutes * MINUTE);
}

function unshift(local: Date, tzOffsetMinutes: number): Date {
  return new Date(local.getTime() - tzOffsetMinutes * MINUTE);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** Parses `tz_offset_minutes`. Falls back to 0 (UTC) when absent or invalid. */
export function parseTzOffset(raw: string | undefined): number {
  if (!raw) return 0;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) return 0;
  // Real offsets span UTC-12:00 to UTC+14:00.
  return Math.min(Math.max(parsed, -720), 840);
}

// ─── Range resolution ─────────────────────────────────────────────────────────

export type ResolvedRange = {
  preset: RangePreset;
  range: DateRange;
  /** The immediately preceding window of equal length, for period-over-period deltas. */
  previous: DateRange;
  tz_offset_minutes: number;
};

/**
 * Resolves a preset (or an explicit start/end pair) into a concrete window
 * plus the comparison window that precedes it.
 *
 * `start` / `end` accept either a date (`2026-08-01`) or a full ISO timestamp.
 * A bare date is interpreted as local midnight; a bare `end` date is inclusive,
 * so `end=2026-08-31` covers all of August 31st.
 */
export function resolveRange(params: {
  range?: string;
  start?: string;
  end?: string;
  tzOffsetMinutes?: number;
  now?: Date;
}): ResolvedRange {
  const tz = params.tzOffsetMinutes ?? 0;
  const now = params.now ?? new Date();
  const localNow = shift(now, tz);

  const requested = (params.range ?? "").toLowerCase();
  // Explicit dates always win, whatever the preset says.
  const hasExplicitDates = Boolean(params.start || params.end);
  const preset: RangePreset = hasExplicitDates
    ? "custom"
    : (RANGE_PRESETS.includes(requested as RangePreset) ? (requested as RangePreset) : "30d");

  const localMidnight = startOfLocalDay(localNow);

  let startLocal: Date;
  let endLocal: Date;

  switch (preset) {
    case "custom": {
      startLocal = params.start
        ? parseBoundary(params.start, "start", localMidnight)
        : new Date(localMidnight.getTime() - 29 * DAY);
      endLocal = params.end ? parseBoundary(params.end, "end", localNow) : localNow;
      // Guard against an inverted range.
      if (endLocal.getTime() < startLocal.getTime()) {
        endLocal = new Date(startLocal.getTime());
      }
      break;
    }
    case "today":
      startLocal = localMidnight;
      endLocal = localNow;
      break;
    case "yesterday":
      startLocal = new Date(localMidnight.getTime() - DAY);
      endLocal = localMidnight;
      break;
    case "7d":
      startLocal = new Date(localMidnight.getTime() - 6 * DAY);
      endLocal = localNow;
      break;
    case "30d":
      startLocal = new Date(localMidnight.getTime() - 29 * DAY);
      endLocal = localNow;
      break;
    case "90d":
      startLocal = new Date(localMidnight.getTime() - 89 * DAY);
      endLocal = localNow;
      break;
    case "12m":
      startLocal = new Date(
        Date.UTC(localMidnight.getUTCFullYear() - 1, localMidnight.getUTCMonth(), localMidnight.getUTCDate())
      );
      endLocal = localNow;
      break;
    case "mtd":
      startLocal = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), 1));
      endLocal = localNow;
      break;
    case "last_month":
      startLocal = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth() - 1, 1));
      endLocal = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), 1));
      break;
    case "ytd":
      startLocal = new Date(Date.UTC(localNow.getUTCFullYear(), 0, 1));
      endLocal = localNow;
      break;
    case "all":
      startLocal = new Date(0);
      endLocal = localNow;
      break;
  }

  const range: DateRange = {
    start: unshift(startLocal, tz).toISOString(),
    end: unshift(endLocal, tz).toISOString(),
  };

  return {
    preset,
    range,
    previous: previousRange(range, preset, tz),
    tz_offset_minutes: tz,
  };
}

/**
 * The comparison window. For calendar-month presets it is the same calendar
 * span one month earlier; for everything else it is the window of equal length
 * immediately before `range`, so a partial "today" compares against the same
 * hours of yesterday.
 */
function previousRange(range: DateRange, preset: RangePreset, tz: number): DateRange {
  const start = new Date(range.start);
  const end = new Date(range.end);

  if (preset === "mtd" || preset === "last_month") {
    const localStart = shift(start, tz);
    const localEnd = shift(end, tz);
    const prevStart = new Date(
      Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth() - 1, 1)
    );
    const spanMs = localEnd.getTime() - localStart.getTime();
    return {
      start: unshift(prevStart, tz).toISOString(),
      end: unshift(new Date(prevStart.getTime() + spanMs), tz).toISOString(),
    };
  }

  const span = Math.max(end.getTime() - start.getTime(), 0);
  return {
    start: new Date(start.getTime() - span).toISOString(),
    end: range.start,
  };
}

/** `YYYY-MM-DD` → local midnight. Full ISO strings pass through untouched. */
function parseBoundary(raw: string, kind: "start" | "end", fallback: Date): Date {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
  if (dateOnly) {
    const [, y, m, d] = dateOnly;
    const midnight = Date.UTC(Number(y), Number(m) - 1, Number(d));
    // A bare end date is inclusive → advance to the next local midnight.
    return new Date(kind === "end" ? midnight + DAY : midnight);
  }
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? fallback : parsed;
}

function startOfLocalDay(local: Date): Date {
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

// ─── Bucketing ────────────────────────────────────────────────────────────────

/**
 * Picks a sensible chart granularity for a range: hourly for a day or less,
 * daily up to ~3 months, weekly up to a year, monthly beyond that.
 */
export function defaultInterval(range: DateRange): TimeseriesInterval {
  const span = new Date(range.end).getTime() - new Date(range.start).getTime();
  if (span <= 2 * DAY) return "hour";
  if (span <= 95 * DAY) return "day";
  if (span <= 400 * DAY) return "week";
  return "month";
}

/**
 * Coarsens the interval until the range produces at most MAX_BUCKETS points.
 * Prevents `range=all&interval=hour` from returning tens of thousands of rows.
 */
export function clampInterval(range: DateRange, interval: TimeseriesInterval): TimeseriesInterval {
  const order = ["hour", "day", "week", "month"] as const;
  let index = Math.max(order.indexOf(interval as (typeof order)[number]), 0);
  while (index < order.length - 1 && estimateBucketCount(range, order[index]!) > MAX_BUCKETS) {
    index += 1;
  }
  return order[index]!;
}

function estimateBucketCount(range: DateRange, interval: TimeseriesInterval): number {
  const span = new Date(range.end).getTime() - new Date(range.start).getTime();
  switch (interval) {
    case "hour":
      return span / (60 * MINUTE);
    case "day":
      return span / DAY;
    case "week":
      return span / (7 * DAY);
    case "month":
      return span / (30 * DAY);
  }
}

/** Formats an instant as the bucket key it belongs to, in the given timezone. */
export function bucketKey(
  instant: Date,
  interval: TimeseriesInterval,
  tzOffsetMinutes: number
): string {
  const d = shift(instant, tzOffsetMinutes);
  const y = d.getUTCFullYear();
  const m = pad(d.getUTCMonth() + 1);
  const day = pad(d.getUTCDate());

  switch (interval) {
    case "hour":
      return `${y}-${m}-${day}T${pad(d.getUTCHours())}:00`;
    case "day":
      return `${y}-${m}-${day}`;
    case "week": {
      const monday = startOfLocalWeek(d);
      return `${monday.getUTCFullYear()}-${pad(monday.getUTCMonth() + 1)}-${pad(monday.getUTCDate())}`;
    }
    case "month":
      return `${y}-${m}`;
  }
}

/** Monday-based start of week, operating on an already-shifted date. */
function startOfLocalWeek(local: Date): Date {
  const midnight = startOfLocalDay(local);
  // getUTCDay(): 0 = Sunday. Shift so Monday = 0.
  const offsetDays = (midnight.getUTCDay() + 6) % 7;
  return new Date(midnight.getTime() - offsetDays * DAY);
}

/**
 * Every bucket key the range covers, in order — used to zero-fill gaps so the
 * chart has a continuous x-axis instead of skipping days with no sales.
 */
export function enumerateBuckets(
  range: DateRange,
  interval: TimeseriesInterval,
  tzOffsetMinutes: number
): string[] {
  const startLocal = shift(new Date(range.start), tzOffsetMinutes);
  const endLocal = shift(new Date(range.end), tzOffsetMinutes);
  if (!(endLocal.getTime() > startLocal.getTime())) return [];

  let cursor = truncateLocal(startLocal, interval);
  const keys: string[] = [];

  while (cursor.getTime() < endLocal.getTime() && keys.length < MAX_BUCKETS) {
    keys.push(bucketKey(unshift(cursor, tzOffsetMinutes), interval, tzOffsetMinutes));
    cursor = advanceLocal(cursor, interval);
  }

  return keys;
}

function truncateLocal(local: Date, interval: TimeseriesInterval): Date {
  switch (interval) {
    case "hour":
      return new Date(
        Date.UTC(
          local.getUTCFullYear(),
          local.getUTCMonth(),
          local.getUTCDate(),
          local.getUTCHours()
        )
      );
    case "day":
      return startOfLocalDay(local);
    case "week":
      return startOfLocalWeek(local);
    case "month":
      return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1));
  }
}

function advanceLocal(local: Date, interval: TimeseriesInterval): Date {
  switch (interval) {
    case "hour":
      return new Date(local.getTime() + 60 * MINUTE);
    case "day":
      return new Date(local.getTime() + DAY);
    case "week":
      return new Date(local.getTime() + 7 * DAY);
    case "month":
      return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + 1, 1));
  }
}

// ─── Deltas ───────────────────────────────────────────────────────────────────

/**
 * Percent change from `previous` to `current`, rounded to one decimal.
 * Returns null when there is no baseline to compare against — the frontend
 * should render "—" rather than a misleading "+100%".
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}
