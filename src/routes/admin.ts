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

const createVariantSchema = z.object({
  size: z.string().min(1).max(100),
  color: z.string().max(100).optional(),
  sku: z.string().max(100).optional(),
  stock: z.number().int().gte(-1).optional().default(-1),
  metadata: z.record(z.unknown()).optional().default({}),
});

const updateVariantSchema = createVariantSchema.partial();

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

// ─── Variant Management Routes ────────────────────────────────────────────────

/**
 * GET /admin/products/:productId/variants
 *
 * Lists all variants for a product.
 *
 * Response: { ok: true, data: ProductVariant[] }
 */
admin.get("/products/:productId/variants", async (c) => {
  const productId = c.req.param("productId");
  try {
    const db = getDatabase(c.env);
    const product = await db.getProduct(productId);
    if (!product) return c.json(err("Product not found"), 404);

    const variants = await db.getProductVariants(productId);
    return c.json(ok(variants));
  } catch (e) {
    console.error(`GET /admin/products/${productId}/variants error:`, e);
    return c.json(err("Failed to fetch variants"), 500);
  }
});

/**
 * GET /admin/products/:productId/variants/:variantId
 *
 * Returns a single variant by ID.
 *
 * Response: { ok: true, data: ProductVariant }
 */
admin.get("/products/:productId/variants/:variantId", async (c) => {
  const variantId = c.req.param("variantId");
  try {
    const db = getDatabase(c.env);
    const variant = await db.getProductVariant(variantId);
    if (!variant) return c.json(err("Variant not found"), 404);
    return c.json(ok(variant));
  } catch (e) {
    console.error(`GET /admin/variants/${variantId} error:`, e);
    return c.json(err("Failed to fetch variant"), 500);
  }
});

/**
 * POST /admin/products/:productId/variants
 *
 * Creates a new variant for a product.
 *
 * Body: { size, color?, sku?, stock?, metadata? }
 * Response: { ok: true, data: ProductVariant }
 */
admin.post(
  "/products/:productId/variants",
  zValidator("json", createVariantSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const productId = c.req.param("productId");
    const input = c.req.valid("json");
    try {
      const db = getDatabase(c.env);
      const product = await db.getProduct(productId);
      if (!product) return c.json(err("Product not found"), 404);

      const variant = await db.createVariant(productId, input);
      return c.json(ok(variant), 201);
    } catch (e) {
      console.error(`POST /admin/products/${productId}/variants error:`, e);
      return c.json(err("Failed to create variant"), 500);
    }
  }
);

/**
 * PUT /admin/products/:productId/variants/:variantId
 *
 * Updates an existing variant.
 *
 * Body: { size?, color?, sku?, stock?, metadata? }
 * Response: { ok: true, data: ProductVariant }
 */
admin.put(
  "/products/:productId/variants/:variantId",
  zValidator("json", updateVariantSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const variantId = c.req.param("variantId");
    const input = c.req.valid("json");
    try {
      const db = getDatabase(c.env);
      const variant = await db.updateVariant(variantId, input);
      if (!variant) return c.json(err("Variant not found"), 404);
      return c.json(ok(variant));
    } catch (e) {
      console.error(`PUT /admin/variants/${variantId} error:`, e);
      return c.json(err("Failed to update variant"), 500);
    }
  }
);

/**
 * DELETE /admin/products/:productId/variants/:variantId
 *
 * Deletes a variant.
 *
 * Response: { ok: true, data: { deleted: true } }
 */
admin.delete("/products/:productId/variants/:variantId", async (c) => {
  const variantId = c.req.param("variantId");
  try {
    const db = getDatabase(c.env);
    const deleted = await db.deleteVariant(variantId);
    if (!deleted) return c.json(err("Variant not found"), 404);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    console.error(`DELETE /admin/variants/${variantId} error:`, e);
    return c.json(err("Failed to delete variant"), 500);
  }
});

export { admin };
