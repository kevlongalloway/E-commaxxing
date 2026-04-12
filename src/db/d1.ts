import { randomUUID } from "crypto";
import type {
  Database,
  Product,
  CreateProductInput,
  UpdateProductInput,
  ProductQueryOptions,
  Order,
  OrderItem,
  CreateOrderInput,
  UpdateOrderInput,
  OrderQueryOptions,
  OrderStatus,
  FulfillmentStatus,
} from "../types.js";

// ─── Product row shape from D1 ────────────────────────────────────────────────

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

// ─── Order row shapes from D1 ─────────────────────────────────────────────────

type OrderRow = {
  id: string;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  status: string;
  fulfillment_status: string;
  customer_email: string | null;
  customer_name: string | null;
  shipping_name: string | null;
  shipping_address_line1: string | null;
  shipping_address_line2: string | null;
  shipping_city: string | null;
  shipping_state: string | null;
  shipping_postal_code: string | null;
  shipping_country: string | null;
  shipping_phone: string | null;
  shipping_carrier: string | null;
  shipping_service: string | null;
  tracking_number: string | null;
  label_url: string | null;
  amount_total: number;
  currency: string;
  metadata: string;  // JSON string
  notes: string;
  created_at: string;
  updated_at: string;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  price: number;
  quantity: number;
  currency: string;
};

function rowToOrder(row: OrderRow, items: OrderItemRow[]): Order {
  return {
    ...row,
    status: row.status as OrderStatus,
    fulfillment_status: row.fulfillment_status as FulfillmentStatus,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    items: items.map((i) => ({ ...i })),
  };
}

// ─── D1Database ───────────────────────────────────────────────────────────────

export class D1Database implements Database {
  constructor(private readonly db: D1Database_CF) {}

  // ── Products ────────────────────────────────────────────────────────────────

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

  // ── Orders ──────────────────────────────────────────────────────────────────

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const id = randomUUID();
    const now = new Date().toISOString();

    await this.db
      .prepare(
        `INSERT INTO orders
           (id, stripe_session_id, stripe_payment_intent_id, status, fulfillment_status,
            customer_email, customer_name,
            shipping_name, shipping_address_line1, shipping_address_line2,
            shipping_city, shipping_state, shipping_postal_code, shipping_country,
            shipping_phone, shipping_carrier, shipping_service,
            tracking_number, label_url,
            amount_total, currency, metadata, notes, created_at, updated_at)
         VALUES
           (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
            ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25)`
      )
      .bind(
        id,
        input.stripe_session_id ?? null,
        input.stripe_payment_intent_id ?? null,
        input.status ?? "pending",
        "unfulfilled",
        input.customer_email ?? null,
        input.customer_name ?? null,
        input.shipping_name ?? null,
        input.shipping_address_line1 ?? null,
        input.shipping_address_line2 ?? null,
        input.shipping_city ?? null,
        input.shipping_state ?? null,
        input.shipping_postal_code ?? null,
        input.shipping_country ?? null,
        input.shipping_phone ?? null,
        null, // shipping_carrier
        null, // shipping_service
        null, // tracking_number
        null, // label_url
        input.amount_total,
        input.currency,
        JSON.stringify(input.metadata ?? {}),
        input.notes ?? "",
        now,
        now
      )
      .run();

    // Insert order items
    const itemRows: OrderItemRow[] = [];
    for (const item of input.items) {
      const itemId = randomUUID();
      await this.db
        .prepare(
          `INSERT INTO order_items (id, order_id, product_id, product_name, price, quantity, currency)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
        )
        .bind(itemId, id, item.product_id, item.product_name, item.price, item.quantity, item.currency)
        .run();
      itemRows.push({ id: itemId, order_id: id, ...item });
    }

    const orderRow: OrderRow = {
      id,
      stripe_session_id: input.stripe_session_id ?? null,
      stripe_payment_intent_id: input.stripe_payment_intent_id ?? null,
      status: input.status ?? "pending",
      fulfillment_status: "unfulfilled",
      customer_email: input.customer_email ?? null,
      customer_name: input.customer_name ?? null,
      shipping_name: input.shipping_name ?? null,
      shipping_address_line1: input.shipping_address_line1 ?? null,
      shipping_address_line2: input.shipping_address_line2 ?? null,
      shipping_city: input.shipping_city ?? null,
      shipping_state: input.shipping_state ?? null,
      shipping_postal_code: input.shipping_postal_code ?? null,
      shipping_country: input.shipping_country ?? null,
      shipping_phone: input.shipping_phone ?? null,
      shipping_carrier: null,
      shipping_service: null,
      tracking_number: null,
      label_url: null,
      amount_total: input.amount_total,
      currency: input.currency,
      metadata: JSON.stringify(input.metadata ?? {}),
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    return rowToOrder(orderRow, itemRows);
  }

  async getOrder(id: string): Promise<Order | null> {
    const row = await this.db
      .prepare("SELECT * FROM orders WHERE id = ?1")
      .bind(id)
      .first<OrderRow>();

    if (!row) return null;

    const { results: items } = await this.db
      .prepare("SELECT * FROM order_items WHERE order_id = ?1")
      .bind(id)
      .all<OrderItemRow>();

    return rowToOrder(row, items ?? []);
  }

  async getOrderByStripeSession(sessionId: string): Promise<Order | null> {
    const row = await this.db
      .prepare("SELECT * FROM orders WHERE stripe_session_id = ?1")
      .bind(sessionId)
      .first<OrderRow>();

    if (!row) return null;

    const { results: items } = await this.db
      .prepare("SELECT * FROM order_items WHERE order_id = ?1")
      .bind(row.id)
      .all<OrderItemRow>();

    return rowToOrder(row, items ?? []);
  }

  async getOrderByStripeIntent(intentId: string): Promise<Order | null> {
    const row = await this.db
      .prepare("SELECT * FROM orders WHERE stripe_payment_intent_id = ?1")
      .bind(intentId)
      .first<OrderRow>();

    if (!row) return null;

    const { results: items } = await this.db
      .prepare("SELECT * FROM order_items WHERE order_id = ?1")
      .bind(row.id)
      .all<OrderItemRow>();

    return rowToOrder(row, items ?? []);
  }

  async getOrders(options: OrderQueryOptions = {}): Promise<Order[]> {
    const { limit = 50, offset = 0, status, fulfillment_status } = options;

    let query = "SELECT * FROM orders";
    const conditions: string[] = [];
    const bindings: unknown[] = [];

    if (status) {
      conditions.push(`status = ?${bindings.length + 1}`);
      bindings.push(status);
    }
    if (fulfillment_status) {
      conditions.push(`fulfillment_status = ?${bindings.length + 1}`);
      bindings.push(fulfillment_status);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }

    query += ` ORDER BY created_at DESC LIMIT ?${bindings.length + 1} OFFSET ?${bindings.length + 2}`;
    bindings.push(limit, offset);

    const { results: orderRows } = await this.db
      .prepare(query)
      .bind(...bindings)
      .all<OrderRow>();

    if (!orderRows || orderRows.length === 0) return [];

    // Fetch all items for these orders in one query.
    const orderIds = orderRows.map((o) => o.id);
    const placeholders = orderIds.map((_, i) => `?${i + 1}`).join(",");
    const { results: itemRows } = await this.db
      .prepare(`SELECT * FROM order_items WHERE order_id IN (${placeholders})`)
      .bind(...orderIds)
      .all<OrderItemRow>();

    // Group items by order_id.
    const itemsByOrder = new Map<string, OrderItemRow[]>();
    for (const item of itemRows ?? []) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push(item);
      itemsByOrder.set(item.order_id, list);
    }

    return orderRows.map((row) => rowToOrder(row, itemsByOrder.get(row.id) ?? []));
  }

  async updateOrder(id: string, input: UpdateOrderInput): Promise<Order | null> {
    const existing = await this.getOrder(id);
    if (!existing) return null;

    const now = new Date().toISOString();

    await this.db
      .prepare(
        `UPDATE orders SET
           status = ?1, fulfillment_status = ?2,
           customer_email = ?3, customer_name = ?4,
           shipping_name = ?5, shipping_address_line1 = ?6, shipping_address_line2 = ?7,
           shipping_city = ?8, shipping_state = ?9, shipping_postal_code = ?10,
           shipping_country = ?11, shipping_phone = ?12,
           shipping_carrier = ?13, shipping_service = ?14,
           tracking_number = ?15, label_url = ?16,
           notes = ?17, metadata = ?18, updated_at = ?19
         WHERE id = ?20`
      )
      .bind(
        input.status ?? existing.status,
        input.fulfillment_status ?? existing.fulfillment_status,
        input.customer_email !== undefined ? input.customer_email : existing.customer_email,
        input.customer_name !== undefined ? input.customer_name : existing.customer_name,
        input.shipping_name !== undefined ? input.shipping_name : existing.shipping_name,
        input.shipping_address_line1 !== undefined ? input.shipping_address_line1 : existing.shipping_address_line1,
        input.shipping_address_line2 !== undefined ? input.shipping_address_line2 : existing.shipping_address_line2,
        input.shipping_city !== undefined ? input.shipping_city : existing.shipping_city,
        input.shipping_state !== undefined ? input.shipping_state : existing.shipping_state,
        input.shipping_postal_code !== undefined ? input.shipping_postal_code : existing.shipping_postal_code,
        input.shipping_country !== undefined ? input.shipping_country : existing.shipping_country,
        input.shipping_phone !== undefined ? input.shipping_phone : existing.shipping_phone,
        input.shipping_carrier !== undefined ? input.shipping_carrier : existing.shipping_carrier,
        input.shipping_service !== undefined ? input.shipping_service : existing.shipping_service,
        input.tracking_number !== undefined ? input.tracking_number : existing.tracking_number,
        input.label_url !== undefined ? input.label_url : existing.label_url,
        input.notes !== undefined ? input.notes : existing.notes,
        JSON.stringify(input.metadata ?? existing.metadata),
        now,
        id
      )
      .run();

    return this.getOrder(id);
  }
}

// Alias to avoid naming collision with the Cloudflare Workers D1Database type.
type D1Database_CF = globalThis.D1Database;
