import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

const admin = new Hono<{ Bindings: Bindings }>();

// ─── Validation schemas ───────────────────────────────────────────────────────

const createProductSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().max(5000).optional().default(""),
  price: z
    .number()
    .int("Price must be an integer (smallest currency unit, e.g. cents)")
    .positive(),
  currency: z.string().length(3).toLowerCase().optional(),
  images: z.array(z.string().url()).optional().default([]),
  metadata: z.record(z.unknown()).optional().default({}),
  stock: z.number().int().gte(-1).optional().default(-1),
  active: z.boolean().optional().default(true),
});

const updateProductSchema = createProductSchema.partial();

// ─── Admin Routes (all protected by adminAuthMiddleware in index.ts) ──────────

/**
 * GET /admin/products
 *
 * Lists all products (including inactive ones).
 *
 * Query params:
 *   limit       - default 50, max 100
 *   offset      - default 0
 *   active_only - "true" | "false" (default "false" — admins see everything)
 *
 * Response: { ok: true, data: Product[] }
 */
admin.get("/products", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);
  const activeOnly = c.req.query("active_only") === "true";

  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 100);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  try {
    const db = getDatabase(c.env);
    const data = await db.getProducts({ limit, offset, activeOnly });
    return c.json(ok(data));
  } catch (e) {
    console.error("GET /admin/products error:", e);
    return c.json(err("Failed to fetch products"), 500);
  }
});

/**
 * GET /admin/products/:id
 *
 * Returns a single product by ID (including inactive ones).
 */
admin.get("/products/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDatabase(c.env);
    const product = await db.getProduct(id);
    if (!product) return c.json(err("Product not found"), 404);
    return c.json(ok(product));
  } catch (e) {
    console.error(`GET /admin/products/${id} error:`, e);
    return c.json(err("Failed to fetch product"), 500);
  }
});

/**
 * POST /admin/products
 *
 * Creates a new product.
 *
 * Body: { name, price, description?, currency?, images?, metadata?, stock?, active? }
 * Response: { ok: true, data: Product }
 */
admin.post(
  "/products",
  zValidator("json", createProductSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const input = c.req.valid("json");
    try {
      const db = getDatabase(c.env);
      const product = await db.createProduct(
        input,
        c.env.DEFAULT_CURRENCY ?? "usd"
      );
      return c.json(ok(product), 201);
    } catch (e) {
      console.error("POST /admin/products error:", e);
      return c.json(err("Failed to create product"), 500);
    }
  }
);

/**
 * PUT /admin/products/reorder
 *
 * Reorders products by updating their display_order field.
 * Must be registered before PUT /products/:id so "reorder" is not captured
 * as an :id parameter.
 *
 * Body: { products: [{ id: string, display_order: number }, ...] }
 * Response: { ok: true, data: Product[] }
 */
admin.put(
  "/products/reorder",
  zValidator(
    "json",
    z.object({
      products: z.array(
        z.object({
          id: z.string(),
          display_order: z.number().int().gte(0),
        })
      ),
    }),
    (result, c) => {
      if (!result.success) {
        return c.json(err("Invalid request body", result.error.flatten()), 400);
      }
    }
  ),
  async (c) => {
    const { products } = c.req.valid("json");
    try {
      const db = getDatabase(c.env);
      const updated = await db.reorderProducts(products);
      return c.json(ok(updated));
    } catch (e) {
      console.error("PUT /admin/products/reorder error:", e);
      return c.json(err("Failed to reorder products"), 500);
    }
  }
);

/**
 * PUT /admin/products/:id
 *
 * Updates an existing product. All fields are optional — only supplied
 * fields are changed.
 *
 * Response: { ok: true, data: Product }
 */
admin.put(
  "/products/:id",
  zValidator("json", updateProductSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json");
    try {
      const db = getDatabase(c.env);
      const product = await db.updateProduct(id, input);
      if (!product) return c.json(err("Product not found"), 404);
      return c.json(ok(product));
    } catch (e) {
      console.error(`PUT /admin/products/${id} error:`, e);
      return c.json(err("Failed to update product"), 500);
    }
  }
);

/**
 * DELETE /admin/products/:id
 *
 * Permanently deletes a product.
 * TIP: prefer PUT to set active=false instead — soft deletes keep history.
 *
 * Response: { ok: true, data: { deleted: true } }
 */
admin.delete("/products/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const db = getDatabase(c.env);
    const deleted = await db.deleteProduct(id);
    if (!deleted) return c.json(err("Product not found"), 404);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    console.error(`DELETE /admin/products/${id} error:`, e);
    return c.json(err("Failed to delete product"), 500);
  }
});

export { admin };
