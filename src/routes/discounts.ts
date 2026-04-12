import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

const discounts = new Hono<{ Bindings: Bindings }>();

// ─── Validation schemas ───────────────────────────────────────────────────────

const createDiscountSchema = z.object({
  code: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[A-Z0-9_-]+$/i, "Code may only contain letters, numbers, hyphens, and underscores")
    .transform((v) => v.toUpperCase())
    .nullable()
    .optional(),
  name: z.string().min(1).max(255),
  description: z.string().max(1000).optional(),
  type: z.enum(["percentage", "fixed_amount", "free_shipping"]),
  value: z.number().int().nonnegative(),
  applies_to: z.enum(["all", "products"]).optional(),
  product_ids: z.array(z.string().uuid()).optional(),
  minimum_order_amount: z.number().int().nonnegative().optional(),
  usage_limit: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
}).refine(
  (d) => d.type !== "percentage" || (d.value >= 1 && d.value <= 100),
  { message: "Percentage discount value must be between 1 and 100", path: ["value"] }
).refine(
  (d) => d.applies_to !== "products" || (d.product_ids && d.product_ids.length > 0),
  { message: "product_ids must be provided when applies_to is 'products'", path: ["product_ids"] }
).refine(
  (d) => !d.starts_at || !d.ends_at || d.starts_at < d.ends_at,
  { message: "starts_at must be before ends_at", path: ["ends_at"] }
);

const updateDiscountSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(1000).optional(),
  type: z.enum(["percentage", "fixed_amount", "free_shipping"]).optional(),
  value: z.number().int().nonnegative().optional(),
  applies_to: z.enum(["all", "products"]).optional(),
  product_ids: z.array(z.string().uuid()).optional(),
  minimum_order_amount: z.number().int().nonnegative().optional(),
  usage_limit: z.number().int().positive().nullable().optional(),
  active: z.boolean().optional(),
  starts_at: z.string().datetime().nullable().optional(),
  ends_at: z.string().datetime().nullable().optional(),
});

// ─── GET /admin/discounts ─────────────────────────────────────────────────────
/**
 * List all discounts/promotions/sales.
 *
 * Query params:
 *   limit        integer  default 50, max 100
 *   offset       integer  default 0
 *   active       "true" | "false"  — filter by active status
 */
discounts.get("/", async (c) => {
  const limit  = Math.min(Math.max(1, parseInt(c.req.query("limit")  ?? "50", 10) || 50), 100);
  const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0",  10) || 0);
  const activeRaw = c.req.query("active");
  const active = activeRaw === "true" ? true : activeRaw === "false" ? false : undefined;

  try {
    const db = getDatabase(c.env);
    const result = await db.getDiscounts({ limit, offset, active });
    return c.json(ok(result));
  } catch (e) {
    console.error("GET /admin/discounts error:", e);
    return c.json(err("Failed to fetch discounts"), 500);
  }
});

// ─── GET /admin/discounts/:id ─────────────────────────────────────────────────
discounts.get("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDatabase(c.env);
    const discount = await db.getDiscount(id);
    if (!discount) return c.json(err("Discount not found"), 404);
    return c.json(ok(discount));
  } catch (e) {
    console.error(`GET /admin/discounts/${id} error:`, e);
    return c.json(err("Failed to fetch discount"), 500);
  }
});

// ─── POST /admin/discounts ────────────────────────────────────────────────────
/**
 * Create a discount, promotion, or sale.
 *
 * Set `code` to null (or omit it) to create an automatic discount (sale/promotion)
 * that is applied without a customer entering a code.
 *
 * Set `code` to a string (e.g. "SUMMER20") to create a code-required discount.
 */
discounts.post(
  "/",
  zValidator("json", createDiscountSchema, (result, c) => {
    if (!result.success) return c.json(err("Validation failed", result.error.flatten()), 422);
  }),
  async (c) => {
    const input = c.req.valid("json");
    try {
      const db = getDatabase(c.env);

      // Ensure code uniqueness.
      if (input.code) {
        const existing = await db.getDiscountByCode(input.code);
        if (existing) {
          return c.json(err(`Discount code "${input.code}" already exists`), 409);
        }
      }

      const discount = await db.createDiscount({ ...input, value: input.value ?? 0 });
      return c.json(ok(discount), 201);
    } catch (e) {
      console.error("POST /admin/discounts error:", e);
      return c.json(err("Failed to create discount"), 500);
    }
  }
);

// ─── PUT /admin/discounts/:id ─────────────────────────────────────────────────
/**
 * Update a discount. Partial update — only included fields change.
 * Note: `code` cannot be changed after creation.
 */
discounts.put(
  "/:id",
  zValidator("json", updateDiscountSchema, (result, c) => {
    if (!result.success) return c.json(err("Validation failed", result.error.flatten()), 422);
  }),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json");
    try {
      const db = getDatabase(c.env);
      const updated = await db.updateDiscount(id, input);
      if (!updated) return c.json(err("Discount not found"), 404);
      return c.json(ok(updated));
    } catch (e) {
      console.error(`PUT /admin/discounts/${id} error:`, e);
      return c.json(err("Failed to update discount"), 500);
    }
  }
);

// ─── DELETE /admin/discounts/:id ──────────────────────────────────────────────
discounts.delete("/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDatabase(c.env);
    const deleted = await db.deleteDiscount(id);
    if (!deleted) return c.json(err("Discount not found"), 404);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    console.error(`DELETE /admin/discounts/${id} error:`, e);
    return c.json(err("Failed to delete discount"), 500);
  }
});

export { discounts };
