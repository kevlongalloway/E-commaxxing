import { Hono } from "hono";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

const products = new Hono<{ Bindings: Bindings }>();

/**
 * GET /products
 *
 * Returns all active products.
 *
 * Query params:
 *   limit  - number of results (default 50, max 100)
 *   offset - pagination offset (default 0)
 *
 * Response: { ok: true, data: Product[] }
 */
products.get("/", async (c) => {
  const rawLimit = parseInt(c.req.query("limit") ?? "50", 10);
  const rawOffset = parseInt(c.req.query("offset") ?? "0", 10);

  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 100);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  try {
    const db = getDatabase(c.env);
    const data = await db.getProducts({ limit, offset, activeOnly: true });
    return c.json(ok(data));
  } catch (e) {
    console.error("GET /products error:", e);
    return c.json(err("Failed to fetch products"), 500);
  }
});

/**
 * GET /products/:id
 *
 * Returns a single active product by ID.
 *
 * Response: { ok: true, data: Product }
 */
products.get("/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const db = getDatabase(c.env);
    const product = await db.getProduct(id);

    if (!product) {
      return c.json(err("Product not found"), 404);
    }
    if (!product.active) {
      return c.json(err("Product not found"), 404);
    }

    return c.json(ok(product));
  } catch (e) {
    console.error(`GET /products/${id} error:`, e);
    return c.json(err("Failed to fetch product"), 500);
  }
});

export { products };
