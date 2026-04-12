import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";
import type { OrderStatus, FulfillmentStatus } from "../types.js";

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
 * List all orders, newest first.
 *
 * Query params:
 *   limit           integer  default 50, max 100
 *   offset          integer  default 0
 *   status          "pending" | "paid" | "fulfilled" | "cancelled"
 *   fulfillment_status  "unfulfilled" | "processing" | "shipped" | "delivered"
 */
orders.get("/", async (c) => {
  const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
  const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
  const statusRaw = c.req.query("status");
  const fulfillmentRaw = c.req.query("fulfillment_status");

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

  try {
    const db = getDatabase(c.env);
    const result = await db.getOrders({ limit, offset, status, fulfillment_status });
    return c.json(ok(result));
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
