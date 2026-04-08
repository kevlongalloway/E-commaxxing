import { randomUUID } from "crypto";
import type {
  Database,
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryOptions,
  User,
  UserWithHash,
  CreateUserInput,
} from "../types.js";
import { hashPassword } from "../lib/password.js";

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

function rowToProduct(row: ProductRow): Product {
  return {
    ...row,
    images: JSON.parse(row.images) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    active: row.active === 1,
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

  async createUser(input: CreateUserInput): Promise<User> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const password_hash = await hashPassword(input.password);

    await this.db
      .prepare(
        "INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)"
      )
      .bind(id, input.email.toLowerCase(), password_hash, now, now)
      .run();

    return { id, email: input.email.toLowerCase(), created_at: now, updated_at: now };
  }

  async getUserByEmail(email: string): Promise<UserWithHash | null> {
    const row = await this.db
      .prepare("SELECT * FROM users WHERE email = ?1")
      .bind(email.toLowerCase())
      .first<{ id: string; email: string; password_hash: string; created_at: string; updated_at: string }>();

    return row ?? null;
  }

  async getUserById(id: string): Promise<User | null> {
    const row = await this.db
      .prepare("SELECT id, email, created_at, updated_at FROM users WHERE id = ?1")
      .bind(id)
      .first<User>();

    return row ?? null;
  }
}

// Alias to avoid naming collision with the Cloudflare Workers D1Database type.
type D1Database_CF = globalThis.D1Database;
