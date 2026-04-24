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
  Discount,
  CreateDiscountInput,
  UpdateDiscountInput,
  DiscountQueryOptions,
  DiscountType,
  DiscountAppliesTo,
} from "../types.js";

// Lazy-import mongodb to avoid bundling issues when using D1.
// The `mongodb` package works in Cloudflare Workers with `nodejs_compat_v2`.
type MongoClientType = import("mongodb").MongoClient;
type ProductCollectionType = import("mongodb").Collection<MongoProductDoc>;
type OrderCollectionType = import("mongodb").Collection<MongoOrderDoc>;
type OrderItemCollectionType = import("mongodb").Collection<MongoOrderItemDoc>;
type DiscountCollectionType = import("mongodb").Collection<MongoDiscountDoc>;

type MongoProductDoc = Omit<Product, "id"> & { _id: string };

type MongoOrderItemDoc = Omit<OrderItem, "id"> & { _id: string };

type MongoOrderDoc = Omit<Order, "id" | "items"> & {
  _id: string;
};

type MongoDiscountDoc = Omit<Discount, "id"> & { _id: string };

let _client: MongoClientType | null = null;

async function getClient(uri: string): Promise<MongoClientType> {
  if (!_client) {
    const { MongoClient } = await import("mongodb");
    _client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await _client.connect();
  }
  return _client;
}

export class MongoDatabase implements Database {
  constructor(
    private readonly uri: string,
    private readonly dbName: string
  ) {}

  private async productCol(): Promise<ProductCollectionType> {
    const client = await getClient(this.uri);
    return client.db(this.dbName).collection<MongoProductDoc>("products");
  }

  private async orderCol(): Promise<OrderCollectionType> {
    const client = await getClient(this.uri);
    return client.db(this.dbName).collection<MongoOrderDoc>("orders");
  }

  private async orderItemCol(): Promise<OrderItemCollectionType> {
    const client = await getClient(this.uri);
    return client.db(this.dbName).collection<MongoOrderItemDoc>("order_items");
  }

  private async discountCol(): Promise<DiscountCollectionType> {
    const client = await getClient(this.uri);
    return client.db(this.dbName).collection<MongoDiscountDoc>("discounts");
  }

  // ── Products ────────────────────────────────────────────────────────────────

  async getProducts(options: ProductQueryOptions = {}): Promise<Product[]> {
    const { limit = 50, offset = 0, activeOnly = true } = options;
    const col = await this.productCol();

    const filter = activeOnly ? { active: true } : {};
    const docs = await col
      .find(filter)
      .sort({ display_order: 1, created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return docs.map(docToProduct);
  }

  async getProduct(id: string): Promise<Product | null> {
    const col = await this.productCol();
    const doc = await col.findOne({ _id: id });
    return doc ? docToProduct(doc) : null;
  }

  async createProduct(
    input: CreateProductInput,
    defaultCurrency: string
  ): Promise<Product> {
    const col = await this.productCol();
    const now = new Date().toISOString();

    const doc: MongoProductDoc = {
      _id: randomUUID(),
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
      display_order: 999999,
      created_at: now,
      updated_at: now,
    };

    await col.insertOne(doc);
    return docToProduct(doc);
  }

  async updateProduct(
    id: string,
    input: UpdateProductInput
  ): Promise<Product | null> {
    const col = await this.productCol();
    const now = new Date().toISOString();

    const updateFields: Partial<MongoProductDoc> = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.price !== undefined && { price: input.price }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.images !== undefined && { images: input.images }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      ...(input.stock !== undefined && { stock: input.stock }),
      ...(input.active !== undefined && { active: input.active }),
      updated_at: now,
    };

    const result = await col.findOneAndUpdate(
      { _id: id },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    return result ? docToProduct(result) : null;
  }

  async deleteProduct(id: string): Promise<boolean> {
    const col = await this.productCol();
    const result = await col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async updateStripeIds(
    id: string,
    stripeProductId: string,
    stripePriceId: string
  ): Promise<void> {
    const col = await this.productCol();
    await col.updateOne(
      { _id: id },
      {
        $set: {
          stripe_product_id: stripeProductId,
          stripe_price_id: stripePriceId,
          updated_at: new Date().toISOString(),
        },
      }
    );
  }

  async reorderProducts(updates: Array<{ id: string; display_order: number }>): Promise<Product[]> {
    const col = await this.productCol();
    const now = new Date().toISOString();
    for (const update of updates) {
      await col.updateOne(
        { _id: update.id },
        { $set: { display_order: update.display_order, updated_at: now } }
      );
    }
    const ids = updates.map((u) => u.id);
    const docs = await col.find({ _id: { $in: ids } }).toArray();
    return docs.map(docToProduct);
  }

  // ── Orders ──────────────────────────────────────────────────────────────────

  async createOrder(input: CreateOrderInput): Promise<Order> {
    const orderCol = await this.orderCol();
    const itemCol = await this.orderItemCol();
    const now = new Date().toISOString();
    const id = randomUUID();

    const orderDoc: MongoOrderDoc = {
      _id: id,
      stripe_session_id: input.stripe_session_id ?? null,
      stripe_payment_intent_id: input.stripe_payment_intent_id ?? null,
      status: (input.status ?? "pending") as OrderStatus,
      fulfillment_status: "unfulfilled" as FulfillmentStatus,
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
      discount_id: input.discount_id ?? null,
      discount_code: input.discount_code ?? null,
      discount_amount: input.discount_amount ?? 0,
      metadata: input.metadata ?? {},
      notes: input.notes ?? "",
      created_at: now,
      updated_at: now,
    };

    await orderCol.insertOne(orderDoc);

    const itemDocs: MongoOrderItemDoc[] = input.items.map((item) => ({
      _id: randomUUID(),
      order_id: id,
      product_id: item.product_id,
      product_name: item.product_name,
      price: item.price,
      quantity: item.quantity,
      currency: item.currency,
    }));

    if (itemDocs.length > 0) {
      await itemCol.insertMany(itemDocs);
    }

    return docToOrder(orderDoc, itemDocs.map(docToOrderItem));
  }

  async getOrder(id: string): Promise<Order | null> {
    const orderCol = await this.orderCol();
    const itemCol = await this.orderItemCol();

    const doc = await orderCol.findOne({ _id: id });
    if (!doc) return null;

    const itemDocs = await itemCol.find({ order_id: id }).toArray();
    return docToOrder(doc, itemDocs.map(docToOrderItem));
  }

  async getOrderByStripeSession(sessionId: string): Promise<Order | null> {
    const orderCol = await this.orderCol();
    const itemCol = await this.orderItemCol();

    const doc = await orderCol.findOne({ stripe_session_id: sessionId });
    if (!doc) return null;

    const itemDocs = await itemCol.find({ order_id: doc._id }).toArray();
    return docToOrder(doc, itemDocs.map(docToOrderItem));
  }

  async getOrderByStripeIntent(intentId: string): Promise<Order | null> {
    const orderCol = await this.orderCol();
    const itemCol = await this.orderItemCol();

    const doc = await orderCol.findOne({ stripe_payment_intent_id: intentId });
    if (!doc) return null;

    const itemDocs = await itemCol.find({ order_id: doc._id }).toArray();
    return docToOrder(doc, itemDocs.map(docToOrderItem));
  }

  async getOrders(options: OrderQueryOptions = {}): Promise<Order[]> {
    const { limit = 50, offset = 0, status, fulfillment_status } = options;
    const orderCol = await this.orderCol();
    const itemCol = await this.orderItemCol();

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (fulfillment_status) filter.fulfillment_status = fulfillment_status;

    const docs = await orderCol
      .find(filter)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    if (docs.length === 0) return [];

    const orderIds = docs.map((d) => d._id);
    const allItems = await itemCol.find({ order_id: { $in: orderIds } }).toArray();

    const itemsByOrder = new Map<string, OrderItem[]>();
    for (const item of allItems) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push(docToOrderItem(item));
      itemsByOrder.set(item.order_id, list);
    }

    return docs.map((doc) => docToOrder(doc, itemsByOrder.get(doc._id) ?? []));
  }

  async updateOrder(id: string, input: UpdateOrderInput): Promise<Order | null> {
    const orderCol = await this.orderCol();
    const now = new Date().toISOString();

    const updateFields: Partial<MongoOrderDoc> = {
      ...(input.status !== undefined && { status: input.status }),
      ...(input.fulfillment_status !== undefined && { fulfillment_status: input.fulfillment_status }),
      ...(input.customer_email !== undefined && { customer_email: input.customer_email }),
      ...(input.customer_name !== undefined && { customer_name: input.customer_name }),
      ...(input.shipping_name !== undefined && { shipping_name: input.shipping_name }),
      ...(input.shipping_address_line1 !== undefined && { shipping_address_line1: input.shipping_address_line1 }),
      ...(input.shipping_address_line2 !== undefined && { shipping_address_line2: input.shipping_address_line2 }),
      ...(input.shipping_city !== undefined && { shipping_city: input.shipping_city }),
      ...(input.shipping_state !== undefined && { shipping_state: input.shipping_state }),
      ...(input.shipping_postal_code !== undefined && { shipping_postal_code: input.shipping_postal_code }),
      ...(input.shipping_country !== undefined && { shipping_country: input.shipping_country }),
      ...(input.shipping_phone !== undefined && { shipping_phone: input.shipping_phone }),
      ...(input.shipping_carrier !== undefined && { shipping_carrier: input.shipping_carrier }),
      ...(input.shipping_service !== undefined && { shipping_service: input.shipping_service }),
      ...(input.tracking_number !== undefined && { tracking_number: input.tracking_number }),
      ...(input.label_url !== undefined && { label_url: input.label_url }),
      ...(input.notes !== undefined && { notes: input.notes }),
      ...(input.metadata !== undefined && { metadata: input.metadata }),
      updated_at: now,
    };

    const result = await orderCol.findOneAndUpdate(
      { _id: id },
      { $set: updateFields },
      { returnDocument: "after" }
    );

    if (!result) return null;
    return this.getOrder(id);
  }

  // ── Discounts ────────────────────────────────────────────────────────────────

  async createDiscount(input: CreateDiscountInput): Promise<Discount> {
    const col = await this.discountCol();
    const now = new Date().toISOString();

    const doc: MongoDiscountDoc = {
      _id: randomUUID(),
      code: input.code?.toUpperCase() ?? null,
      name: input.name,
      description: input.description ?? "",
      type: input.type as DiscountType,
      value: input.value,
      applies_to: (input.applies_to ?? "all") as DiscountAppliesTo,
      product_ids: input.product_ids ?? [],
      minimum_order_amount: input.minimum_order_amount ?? 0,
      usage_limit: input.usage_limit ?? null,
      usage_count: 0,
      active: input.active ?? true,
      starts_at: input.starts_at ?? null,
      ends_at: input.ends_at ?? null,
      created_at: now,
      updated_at: now,
    };

    await col.insertOne(doc);
    return docToDiscount(doc);
  }

  async getDiscount(id: string): Promise<Discount | null> {
    const col = await this.discountCol();
    const doc = await col.findOne({ _id: id });
    return doc ? docToDiscount(doc) : null;
  }

  async getDiscountByCode(code: string): Promise<Discount | null> {
    const col = await this.discountCol();
    const doc = await col.findOne({ code: code.toUpperCase() });
    return doc ? docToDiscount(doc) : null;
  }

  async getDiscounts(options: DiscountQueryOptions = {}): Promise<Discount[]> {
    const { limit = 50, offset = 0, active } = options;
    const col = await this.discountCol();

    const filter: Record<string, unknown> = {};
    if (active !== undefined) filter.active = active;

    const docs = await col
      .find(filter)
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return docs.map(docToDiscount);
  }

  async getActiveAutomaticDiscounts(): Promise<Discount[]> {
    const col = await this.discountCol();
    const now = new Date().toISOString();

    const docs = await col
      .find({
        active: true,
        code: null,
        $and: [
          { $or: [{ starts_at: null }, { starts_at: { $lte: now } }] },
          { $or: [{ ends_at: null }, { ends_at: { $gt: now } }] },
        ],
      })
      .toArray();

    return docs.map(docToDiscount);
  }

  async updateDiscount(id: string, input: UpdateDiscountInput): Promise<Discount | null> {
    const col = await this.discountCol();
    const now = new Date().toISOString();

    const set: Partial<MongoDiscountDoc> = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.type !== undefined && { type: input.type }),
      ...(input.value !== undefined && { value: input.value }),
      ...(input.applies_to !== undefined && { applies_to: input.applies_to }),
      ...(input.product_ids !== undefined && { product_ids: input.product_ids }),
      ...(input.minimum_order_amount !== undefined && { minimum_order_amount: input.minimum_order_amount }),
      ...(input.usage_limit !== undefined && { usage_limit: input.usage_limit }),
      ...(input.active !== undefined && { active: input.active }),
      ...(input.starts_at !== undefined && { starts_at: input.starts_at }),
      ...(input.ends_at !== undefined && { ends_at: input.ends_at }),
      updated_at: now,
    };

    const result = await col.findOneAndUpdate(
      { _id: id },
      { $set: set },
      { returnDocument: "after" }
    );

    return result ? docToDiscount(result) : null;
  }

  async deleteDiscount(id: string): Promise<boolean> {
    const col = await this.discountCol();
    const result = await col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async incrementDiscountUsage(id: string): Promise<void> {
    const col = await this.discountCol();
    await col.updateOne(
      { _id: id },
      { $inc: { usage_count: 1 }, $set: { updated_at: new Date().toISOString() } }
    );
  }
}

// ─── Conversion helpers ───────────────────────────────────────────────────────

function docToProduct(doc: MongoProductDoc): Product {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function docToOrderItem(doc: MongoOrderItemDoc): OrderItem {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}

function docToOrder(doc: MongoOrderDoc, items: OrderItem[]): Order {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest, items };
}

function docToDiscount(doc: MongoDiscountDoc): Discount {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}
