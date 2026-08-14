import { Hono } from "hono";
import type { Context } from "hono";
import type {
  Bindings,
  DateRange,
  SalesMetrics,
  TimeseriesInterval,
  TimeseriesPoint,
  TopProductSort,
  Order,
} from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";
import {
  resolveRange,
  parseTzOffset,
  defaultInterval,
  clampInterval,
  enumerateBuckets,
  percentChange,
  type ResolvedRange,
} from "../lib/dateRange.js";

const analytics = new Hono<{ Bindings: Bindings }>();

// ─── Shared query parsing ─────────────────────────────────────────────────────

/**
 * Every analytics endpoint accepts the same window parameters:
 *
 *   range              today | yesterday | 7d | 30d | 90d | 12m
 *                      | mtd | last_month | ytd | all | custom   (default 30d)
 *   start, end         ISO date (2026-08-01) or timestamp — forces range=custom
 *   tz_offset_minutes  minutes east of UTC, e.g. -420 for UTC-07:00 (default 0)
 *
 * The frontend gets the offset from `-new Date().getTimezoneOffset()`.
 */
function readRange(c: Context<{ Bindings: Bindings }>): ResolvedRange {
  return resolveRange({
    range: c.req.query("range"),
    start: c.req.query("start"),
    end: c.req.query("end"),
    tzOffsetMinutes: parseTzOffset(c.req.query("tz_offset_minutes")),
  });
}

function readInterval(
  c: Context<{ Bindings: Bindings }>,
  range: DateRange
): TimeseriesInterval {
  const raw = (c.req.query("interval") ?? "").toLowerCase();
  const valid: TimeseriesInterval[] = ["hour", "day", "week", "month"];
  const requested = valid.includes(raw as TimeseriesInterval)
    ? (raw as TimeseriesInterval)
    : defaultInterval(range);
  // Coarsen if the range would produce an unreasonable number of points.
  return clampInterval(range, requested);
}

function readLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = parseInt(raw ?? "", 10);
  if (isNaN(parsed)) return fallback;
  return Math.min(Math.max(parsed, 1), max);
}

/** Serializes the resolved window for the response envelope. */
function rangeEnvelope(resolved: ResolvedRange) {
  return {
    preset: resolved.preset,
    start: resolved.range.start,
    end: resolved.range.end,
    tz_offset_minutes: resolved.tz_offset_minutes,
    previous_start: resolved.previous.start,
    previous_end: resolved.previous.end,
  };
}

/** Period-over-period percent change for every metric. Null = no baseline. */
function metricChanges(
  current: SalesMetrics,
  previous: SalesMetrics
): Record<keyof SalesMetrics, number | null> {
  const keys = Object.keys(current) as Array<keyof SalesMetrics>;
  const changes = {} as Record<keyof SalesMetrics, number | null>;
  for (const key of keys) {
    changes[key] = percentChange(current[key], previous[key]);
  }
  return changes;
}

/**
 * Fills in buckets with no sales so the chart has a continuous x-axis instead
 * of silently skipping quiet days.
 */
function zeroFill(
  points: TimeseriesPoint[],
  range: DateRange,
  interval: TimeseriesInterval,
  tzOffsetMinutes: number
): TimeseriesPoint[] {
  const byBucket = new Map(points.map((p) => [p.bucket, p]));
  return enumerateBuckets(range, interval, tzOffsetMinutes).map(
    (bucket) =>
      byBucket.get(bucket) ?? { bucket, total_sales: 0, orders: 0, units_sold: 0 }
  );
}

/** Trimmed order shape for dashboard tables — no notes, metadata, or labels. */
function orderSummary(order: Order) {
  return {
    id: order.id,
    created_at: order.created_at,
    status: order.status,
    fulfillment_status: order.fulfillment_status,
    customer_name: order.customer_name ?? order.shipping_name,
    customer_email: order.customer_email,
    amount_total: order.amount_total,
    currency: order.currency,
    item_count: order.items.reduce((sum, item) => sum + item.quantity, 0),
  };
}

// ─── GET /admin/analytics/overview ────────────────────────────────────────────
/**
 * KPI cards for the dashboard header: sales, orders, AOV, units, customers —
 * each with the same figure for the preceding window and the percent change.
 *
 * Response: { ok: true, data: { range, currency, metrics, previous, changes, order_counts } }
 */
analytics.get("/overview", async (c) => {
  const resolved = readRange(c);

  try {
    const db = getDatabase(c.env);
    const [metrics, previous, orderCounts] = await Promise.all([
      db.getSalesMetrics(resolved.range),
      db.getSalesMetrics(resolved.previous),
      db.getOrderStatusCounts(resolved.range),
    ]);

    return c.json(
      ok({
        range: rangeEnvelope(resolved),
        currency: c.env.DEFAULT_CURRENCY ?? "usd",
        metrics,
        previous,
        changes: metricChanges(metrics, previous),
        order_counts: orderCounts,
      })
    );
  } catch (e) {
    console.error("GET /admin/analytics/overview error:", e);
    return c.json(err("Failed to compute analytics overview"), 500);
  }
});

// ─── GET /admin/analytics/timeseries ──────────────────────────────────────────
/**
 * Sales over time, zero-filled, for the dashboard chart.
 *
 * Extra query param:
 *   interval  hour | day | week | month  (default: chosen from the range length)
 *   compare   "true" to also return the previous period's points, aligned by
 *             index so the frontend can overlay a dotted comparison line.
 *
 * Response: { ok: true, data: { range, interval, currency, points, previous_points? } }
 */
analytics.get("/timeseries", async (c) => {
  const resolved = readRange(c);
  const interval = readInterval(c, resolved.range);
  const compare = c.req.query("compare") === "true";
  const tz = resolved.tz_offset_minutes;

  try {
    const db = getDatabase(c.env);

    const points = zeroFill(
      await db.getSalesTimeseries(resolved.range, interval, tz),
      resolved.range,
      interval,
      tz
    );

    const previousPoints = compare
      ? zeroFill(
          await db.getSalesTimeseries(resolved.previous, interval, tz),
          resolved.previous,
          interval,
          tz
        )
      : undefined;

    return c.json(
      ok({
        range: rangeEnvelope(resolved),
        interval,
        currency: c.env.DEFAULT_CURRENCY ?? "usd",
        points,
        ...(previousPoints ? { previous_points: previousPoints } : {}),
      })
    );
  } catch (e) {
    console.error("GET /admin/analytics/timeseries error:", e);
    return c.json(err("Failed to compute sales timeseries"), 500);
  }
});

// ─── GET /admin/analytics/top-products ────────────────────────────────────────
/**
 * Best sellers in the window.
 *
 * Extra query params:
 *   limit  1–50, default 5
 *   sort   "units" (default) | "revenue"
 *
 * Response: { ok: true, data: { range, currency, sort, products } }
 */
analytics.get("/top-products", async (c) => {
  const resolved = readRange(c);
  const limit = readLimit(c.req.query("limit"), 5, 50);
  const sort: TopProductSort = c.req.query("sort") === "revenue" ? "revenue" : "units";

  try {
    const db = getDatabase(c.env);
    const products = await db.getTopProducts(resolved.range, limit, sort);

    return c.json(
      ok({
        range: rangeEnvelope(resolved),
        currency: c.env.DEFAULT_CURRENCY ?? "usd",
        sort,
        products,
      })
    );
  } catch (e) {
    console.error("GET /admin/analytics/top-products error:", e);
    return c.json(err("Failed to compute top products"), 500);
  }
});

// ─── GET /admin/analytics/dashboard ───────────────────────────────────────────
/**
 * Everything the dashboard overview page needs, in one request: KPI cards with
 * period-over-period deltas, the sales chart, best sellers, recent orders,
 * things needing attention, and newsletter growth.
 *
 * Prefer this over firing five separate requests on page load.
 *
 * Extra query params:
 *   interval            chart granularity (see /timeseries)
 *   compare             "true" to include the previous period's chart points
 *   top_products_limit  1–50, default 5
 *   recent_orders_limit 1–50, default 10
 *   low_stock_threshold default 5 — products at or below this are flagged
 */
analytics.get("/dashboard", async (c) => {
  const resolved = readRange(c);
  const interval = readInterval(c, resolved.range);
  const compare = c.req.query("compare") === "true";
  const tz = resolved.tz_offset_minutes;
  const topLimit = readLimit(c.req.query("top_products_limit"), 5, 50);
  const recentLimit = readLimit(c.req.query("recent_orders_limit"), 10, 50);
  const lowStockThreshold = readLimit(c.req.query("low_stock_threshold"), 5, 1000);

  try {
    const db = getDatabase(c.env);

    const [
      metrics,
      previous,
      rangeCounts,
      allTimeCounts,
      rawPoints,
      rawPreviousPoints,
      topProducts,
      recentOrders,
      subscriberStats,
      products,
    ] = await Promise.all([
      db.getSalesMetrics(resolved.range),
      db.getSalesMetrics(resolved.previous),
      db.getOrderStatusCounts(resolved.range),
      // Unscoped — "3 orders to fulfill" must include orders older than the
      // selected window, otherwise switching to "Today" hides real work.
      db.getOrderStatusCounts(),
      db.getSalesTimeseries(resolved.range, interval, tz),
      compare
        ? db.getSalesTimeseries(resolved.previous, interval, tz)
        : Promise.resolve<TimeseriesPoint[]>([]),
      db.getTopProducts(resolved.range, topLimit, "units"),
      db.getOrders({ limit: recentLimit, offset: 0 }),
      db.getSubscriberStats(),
      db.getProducts({ limit: 100, offset: 0, activeOnly: true }),
    ]);

    // stock = -1 means unlimited, so it is never "low".
    const lowStock = products
      .filter((p) => p.stock >= 0 && p.stock <= lowStockThreshold)
      .sort((a, b) => a.stock - b.stock)
      .slice(0, 10)
      .map((p) => ({ id: p.id, name: p.name, stock: p.stock }));

    return c.json(
      ok({
        range: rangeEnvelope(resolved),
        currency: c.env.DEFAULT_CURRENCY ?? "usd",
        metrics,
        previous,
        changes: metricChanges(metrics, previous),
        order_counts: rangeCounts,
        chart: {
          interval,
          points: zeroFill(rawPoints, resolved.range, interval, tz),
          ...(compare
            ? {
                previous_points: zeroFill(
                  rawPreviousPoints,
                  resolved.previous,
                  interval,
                  tz
                ),
              }
            : {}),
        },
        top_products: topProducts,
        recent_orders: recentOrders.map(orderSummary),
        needs_attention: {
          // Paid but not yet shipped — the "orders to fulfill" card.
          unfulfilled_orders: allTimeCounts.unfulfilled,
          processing_orders: allTimeCounts.processing,
          // Checkouts that never completed payment.
          pending_orders: allTimeCounts.pending,
          low_stock_products: lowStock,
        },
        newsletter: subscriberStats,
      })
    );
  } catch (e) {
    console.error("GET /admin/analytics/dashboard error:", e);
    return c.json(err("Failed to build dashboard"), 500);
  }
});

export { analytics };
