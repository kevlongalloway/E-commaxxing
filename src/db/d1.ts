import { randomUUID } from "crypto";
import type {
  Database,
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryOptions,
  ProductVariant,
  CreateVariantInput,
  UpdateVariantInput,
} from "../types.js";

// ─── Row shape coming back from D1 ───────────────────────────────────────────
type ProductRow = {
  id: string;
  name: string;
  description: string;
  price: number;
  currency: string;
  images: string;      // JSON string
  metadata: string;    // JSON string
  stock: number;
  active: number;      // 0 | 1 (SQLite has no boolean)
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  created_at: string;
  updated_at: string;
};

type VariantRow = {
  id: string;
  product_id: string;
  size: string;
  color: string | null;
  sku: string | null;
  stock: number;
  metadata: string;    // JSON string
  created_at: string;
  updated_at: string;
};

function rowToProduct(row: ProductRow): Product {
  return {
    ...row,
    images: JSON.parse(row.images) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    active: row.active === 1,
  };
}

function rowToVariant(row: VariantRow): ProductVariant {
  return {
    ...row,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

export class D1Database implements Database {
  constructor(private readonly db: D1Database_CF) {}

  async getProducts(options: ProductQueryOptions = {}): Promise<Product[]> {
    const { limit = 50, offset = 0, activeOnly = true } = options;

    const query = activeOnly
      ? "SELECT * FROM products WHERE active = 1 ORDER BY created_at DESC LIMIT ?1 OFFSET ?2"
      : "SELECT * FROM products ORDER BY created_at DESC LIMIT ?1 OFFSET ?2";

    const { results } = await this.db
      .prepare(query)
      .bind(limit, offset)
      .all<ProductRow>();

    return (results ?? []).map(rowToProduct);
  }

  async getProduct(id: string): Promise<Product | null> {
    const row = await this.db
      .prepare("SELECT * FROM products WHERE id = ?1")
      .bind(id)
      .first<ProductRow>();

    return row ? rowToProduct(row) : null;
  }

  async createProduct(
    input: CreateProductInput,
    defaultCurrency: string
  ): Promise<Product> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const product: Product = {
      id,
      name: input.name,
      description: input.description ?? "",
      price: input.price,
      currency: input.currency ?? defaultCurrency,
      images: input.images ?? [],
      metadata: input.metadata ?? {},
      stock: input.stock ?? -1,
      active: input.active ?? true,
      stripe_product_id: null,
      stripe_price_id: null,
      created_at: now,
      updated_at: now,
    };

    await this.db
      .prepare(
        `INSERT INTO products
          (id, name, description, price, currency, images, metadata, stock, active,
           stripe_product_id, stripe_price_id, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`
      )
      .bind(
        product.id,
        product.name,
        product.description,
        product.price,
        product.currency,
        JSON.stringify(product.images),
        JSON.stringify(product.metadata),
        product.stock,
        product.active ? 1 : 0,
        product.stripe_product_id,
        product.stripe_price_id,
        product.created_at,
        product.updated_at
      )
      .run();

    return product;
  }

  async updateProduct(
    id: string,
    input: UpdateProductInput
  ): Promise<Product | null> {
    const existing = await this.getProduct(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: Product = {
      ...existing,
      ...input,
      images: input.images ?? existing.images,
      metadata: input.metadata ?? existing.metadata,
      updated_at: now,
    };

    await this.db
      .prepare(
        `UPDATE products SET
           name = ?1, description = ?2, price = ?3, currency = ?4,
           images = ?5, metadata = ?6, stock = ?7, active = ?8, updated_at = ?9
         WHERE id = ?10`
      )
      .bind(
        updated.name,
        updated.description,
        updated.price,
        updated.currency,
        JSON.stringify(updated.images),
        JSON.stringify(updated.metadata),
        updated.stock,
        updated.active ? 1 : 0,
        updated.updated_at,
        id
      )
      .run();

    return updated;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare("DELETE FROM products WHERE id = ?1")
      .bind(id)
      .run();
    return (meta.changes ?? 0) > 0;
  }

  async updateStripeIds(
    id: string,
    stripeProductId: string,
    stripePriceId: string
  ): Promise<void> {
    await this.db
      .prepare(
        "UPDATE products SET stripe_product_id = ?1, stripe_price_id = ?2, updated_at = ?3 WHERE id = ?4"
      )
      .bind(stripeProductId, stripePriceId, new Date().toISOString(), id)
      .run();
  }

  async getProductVariants(productId: string): Promise<ProductVariant[]> {
    const { results } = await this.db
      .prepare("SELECT * FROM product_variants WHERE product_id = ?1 ORDER BY created_at ASC")
      .bind(productId)
      .all<VariantRow>();

    return (results ?? []).map(rowToVariant);
  }

  async getProductVariant(id: string): Promise<ProductVariant | null> {
    const row = await this.db
      .prepare("SELECT * FROM product_variants WHERE id = ?1")
      .bind(id)
      .first<VariantRow>();

    return row ? rowToVariant(row) : null;
  }

  async createVariant(
    productId: string,
    input: CreateVariantInput
  ): Promise<ProductVariant> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const variant: ProductVariant = {
      id,
      product_id: productId,
      size: input.size,
      color: input.color ?? null,
      sku: input.sku ?? null,
      stock: input.stock ?? -1,
      metadata: input.metadata ?? {},
      created_at: now,
      updated_at: now,
    };

    await this.db
      .prepare(
        `INSERT INTO product_variants
          (id, product_id, size, color, sku, stock, metadata, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`
      )
      .bind(
        variant.id,
        variant.product_id,
        variant.size,
        variant.color,
        variant.sku,
        variant.stock,
        JSON.stringify(variant.metadata),
        variant.created_at,
        variant.updated_at
      )
      .run();

    return variant;
  }

  async updateVariant(
    id: string,
    input: UpdateVariantInput
  ): Promise<ProductVariant | null> {
    const existing = await this.getProductVariant(id);
    if (!existing) return null;

    const now = new Date().toISOString();
    const updated: ProductVariant = {
      ...existing,
      ...input,
      metadata: input.metadata ?? existing.metadata,
      updated_at: now,
    };

    await this.db
      .prepare(
        `UPDATE product_variants SET
           size = ?1, color = ?2, sku = ?3, stock = ?4, metadata = ?5, updated_at = ?6
         WHERE id = ?7`
      )
      .bind(
        updated.size,
        updated.color,
        updated.sku,
        updated.stock,
        JSON.stringify(updated.metadata),
        updated.updated_at,
        id
      )
      .run();

    return updated;
  }

  async deleteVariant(id: string): Promise<boolean> {
    const { meta } = await this.db
      .prepare("DELETE FROM product_variants WHERE id = ?1")
      .bind(id)
      .run();
    return (meta.changes ?? 0) > 0;
  }
}

// Alias to avoid naming collision with the Cloudflare Workers D1Database type.
type D1Database_CF = globalThis.D1Database;
