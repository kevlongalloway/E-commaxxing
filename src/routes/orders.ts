import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";
import type {
  OrderStatus,
  FulfillmentStatus,
  OrderSortField,
  SortDirection,
} from "../types.js";
import { resolveRange, parseTzOffset } from "../lib/dateRange.js";

const orders = new Hono<{ Bindings: Bindings }>();

// ─── Validation schemas ───────────────────────────────────────────────────────

const updateOrderSchema = z.object({
  status: z.enum(["pending", "paid", "fulfilled", "cancelled"]).optional(),
  fulfillment_status: z
    .enum(["unfulfilled", "processing", "shipped", "delivered"])
    .optional(),
  customer_email: z.string().email().nullable().optional(),
  customer_name: z.string().max(255).nullable().optional(),
  shipping_name: z.string().max(255).nullable().optional(),
  shipping_address_line1: z.string().max(255).nullable().optional(),
  shipping_address_line2: z.string().max(255).nullable().optional(),
  shipping_city: z.string().max(255).nullable().optional(),
  shipping_state: z.string().max(255).nullable().optional(),
  shipping_postal_code: z.string().max(20).nullable().optional(),
  shipping_country: z.string().length(2).nullable().optional(),
  shipping_phone: z.string().max(30).nullable().optional(),
  shipping_carrier: z.string().max(100).nullable().optional(),
  shipping_service: z.string().max(100).nullable().optional(),
  tracking_number: z.string().max(100).nullable().optional(),
  label_url: z.string().url().nullable().optional(),
  notes: z.string().max(5000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

// ─── GET /admin/orders ────────────────────────────────────────────────────────
/**
 * List orders, newest first, with the total count for pagination.
 *
 * Query params:
 *   limit               integer  default 50, max 100
 *   offset              integer  default 0
 *   status              "pending" | "paid" | "fulfilled" | "cancelled"
 *   fulfillment_status  "unfulfilled" | "processing" | "shipped" | "delivered"
 *   search              substring match on customer email/name, order ID, tracking number
 *   sort                "created_at" (default) | "amount_total"
 *   direction           "desc" (default) | "asc"
 *   range               today | yesterday | 7d | 30d | 90d | 12m | mtd | last_month | ytd | all
 *   start, end          ISO date or timestamp — overrides `range`
 *   tz_offset_minutes   timezone for the range presets, e.g. -420
 *
 * Response:
 *   { ok: true, data: Order[], pagination: { total, limit, offset, has_more } }
 *
 * `data` is still a bare array, so existing callers keep working — the counts
 * live alongside it in `pagination`.
 */
orders.get("/", async (c) => {
  const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
  const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
  const statusRaw = c.req.query("status");
  const fulfillmentRaw = c.req.query("fulfillment_status");
  const sortRaw = c.req.query("sort");
  const directionRaw = c.req.query("direction");

  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 100);
  const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);

  const validStatuses = ["pending", "paid", "fulfilled", "cancelled"];
  const validFulfillments = ["unfulfilled", "processing", "shipped", "delivered"];

  const status = statusRaw && validStatuses.includes(statusRaw)
    ? (statusRaw as OrderStatus)
    : undefined;
  const fulfillment_status = fulfillmentRaw && validFulfillments.includes(fulfillmentRaw)
    ? (fulfillmentRaw as FulfillmentStatus)
    : undefined;

  const sort: OrderSortField = sortRaw === "amount_total" ? "amount_total" : "created_at";
  const direction: SortDirection = directionRaw === "asc" ? "asc" : "desc";

  // Date filtering is opt-in: with no range/start/end params, list everything.
  const wantsDateFilter = Boolean(
    c.req.query("range") || c.req.query("start") || c.req.query("end")
  );
  const dateFilter = wantsDateFilter
    ? resolveRange({
        range: c.req.query("range"),
        start: c.req.query("start"),
        end: c.req.query("end"),
        tzOffsetMinutes: parseTzOffset(c.req.query("tz_offset_minutes")),
      }).range
    : undefined;

  const filters = {
    status,
    fulfillment_status,
    search: c.req.query("search")?.trim() || undefined,
    start_date: dateFilter?.start,
    end_date: dateFilter?.end,
  };

  try {
    const db = getDatabase(c.env);
    const [result, total] = await Promise.all([
      db.getOrders({ ...filters, limit, offset, sort, direction }),
      db.countOrders(filters),
    ]);

    return c.json({
      ...ok(result),
      pagination: { total, limit, offset, has_more: offset + result.length < total },
    });
  } catch (e) {
    console.error("GET /admin/orders error:", e);
    return c.json(err("Failed to fetch orders"), 500);
  }
});

// ─── GET /admin/orders/:id ────────────────────────────────────────────────────
/**
 * Get a single order by ID, including all line items.
 */
orders.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDatabase(c.env);
    const order = await db.getOrder(id);
    if (!order) {
      return c.json(err("Order not found"), 404);
    }
    return c.json(ok(order));
  } catch (e) {
    console.error(`GET /admin/orders/${id} error:`, e);
    return c.json(err("Failed to fetch order"), 500);
  }
});

// ─── PUT /admin/orders/:id ────────────────────────────────────────────────────
/**
 * Update an order — partial update, only included fields are changed.
 *
 * Use this to:
 *   - Advance status:            { "status": "fulfilled" }
 *   - Set fulfillment status:    { "fulfillment_status": "shipped" }
 *   - Add tracking manually:     { "tracking_number": "9400...", "shipping_carrier": "USPS" }
 *   - Correct shipping address:  { "shipping_address_line1": "123 Main St" }
 *   - Add internal notes:        { "notes": "Fragile, pack carefully" }
 */
orders.put(
  "/:id",
  zValidator("json", updateOrderSchema, (result, c) => {
    if (!result.success) {
      return c.json(
        err("Validation failed", result.error.flatten()),
        422
      );
    }
  }),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json");

    try {
      const db = getDatabase(c.env);
      const updated = await db.updateOrder(id, input);
      if (!updated) {
        return c.json(err("Order not found"), 404);
      }
      return c.json(ok(updated));
    } catch (e) {
      console.error(`PUT /admin/orders/${id} error:`, e);
      return c.json(err("Failed to update order"), 500);
    }
  }
);

export { orders };
