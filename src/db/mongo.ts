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
  DateRange,
  SalesMetrics,
  TimeseriesInterval,
  TimeseriesPoint,
  TopProduct,
  TopProductSort,
  OrderStatusCounts,
  NewsletterSubscriber,
  CreateSubscriberInput,
  UpdateSubscriberInput,
  SubscriberQueryOptions,
  SubscriberStats,
} from "../types.js";

/** Order statuses that count toward revenue. Pending/cancelled never do. */
const REVENUE_STATUSES = ["paid", "fulfilled"];

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

type MongoSubscriberDoc = Omit<NewsletterSubscriber, "id"> & { _id: string };

type SubscriberCollectionType = import("mongodb").Collection<MongoSubscriberDoc>;

/** Key/value storefront settings — `_id` is the setting key. */
type MongoSettingDoc = { _id: string; value: unknown; updated_at: string };

type SettingCollectionType = import("mongodb").Collection<MongoSettingDoc>;

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

  private async settingCol(): Promise<SettingCollectionType> {
    const client = await getClient(this.uri);
    return client.db(this.dbName).collection<MongoSettingDoc>("settings");
  }

  private async subscriberCol(): Promise<SubscriberCollectionType> {
    const client = await getClient(this.uri);
    return client
      .db(this.dbName)
      .collection<MongoSubscriberDoc>("newsletter_subscribers");
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

  /**
   * Shared filter for order listing and counting, so the two can't drift apart.
   */
  private buildOrderFilter(options: OrderQueryOptions): Record<string, unknown> {
    const filter: Record<string, unknown> = {};

    if (options.status) filter.status = options.status;
    if (options.fulfillment_status) filter.fulfillment_status = options.fulfillment_status;

    if (options.start_date || options.end_date) {
      const createdAt: Record<string, string> = {};
      if (options.start_date) createdAt.$gte = options.start_date;
      if (options.end_date) createdAt.$lt = options.end_date;
      filter.created_at = createdAt;
    }

    if (options.search) {
      // Escape regex metacharacters — the search term is raw user input.
      const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = { $regex: escaped, $options: "i" };
      filter.$or = [
        { customer_email: pattern },
        { customer_name: pattern },
        { shipping_name: pattern },
        { _id: pattern },
        { tracking_number: pattern },
      ];
    }

    return filter;
  }

  async getOrders(options: OrderQueryOptions = {}): Promise<Order[]> {
    const { limit = 50, offset = 0, sort = "created_at", direction = "desc" } = options;
    const orderCol = await this.orderCol();
    const itemCol = await this.orderItemCol();

    const filter = this.buildOrderFilter(options);
    const sortField = sort === "amount_total" ? "amount_total" : "created_at";
    const sortOrder = direction === "asc" ? 1 : -1;

    const docs = await orderCol
      .find(filter)
      .sort({ [sortField]: sortOrder })
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

  async countOrders(options: OrderQueryOptions = {}): Promise<number> {
    const orderCol = await this.orderCol();
    return orderCol.countDocuments(this.buildOrderFilter(options));
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

  // ── Analytics ────────────────────────────────────────────────────────────────

  /** Matches revenue-counting orders inside a window. */
  private revenueMatch(range: DateRange): Record<string, unknown> {
    return {
      status: { $in: REVENUE_STATUSES },
      created_at: { $gte: range.start, $lt: range.end },
    };
  }

  async getSalesMetrics(range: DateRange): Promise<SalesMetrics> {
    const orderCol = await this.orderCol();

    // One pass over the matched orders: money from the order docs, units from
    // the joined line items. $facet keeps it to a single round trip.
    const [facet] = await orderCol
      .aggregate<{
        totals: Array<{
          orders: number;
          total_sales: number;
          discounts: number;
          emails: Array<string | null>;
        }>;
        units: Array<{ units_sold: number }>;
      }>([
        { $match: this.revenueMatch(range) },
        {
          $facet: {
            totals: [
              {
                $group: {
                  _id: null,
                  orders: { $sum: 1 },
                  total_sales: { $sum: "$amount_total" },
                  discounts: { $sum: { $ifNull: ["$discount_amount", 0] } },
                  emails: { $addToSet: "$customer_email" },
                },
              },
            ],
            units: [
              {
                $lookup: {
                  from: "order_items",
                  localField: "_id",
                  foreignField: "order_id",
                  as: "items",
                },
              },
              {
                $group: {
                  _id: null,
                  units_sold: { $sum: { $sum: "$items.quantity" } },
                },
              },
            ],
          },
        },
      ])
      .toArray();

    const totals = facet?.totals?.[0];
    const orders = totals?.orders ?? 0;
    const total_sales = totals?.total_sales ?? 0;
    const discounts = totals?.discounts ?? 0;

    // Customers who placed their first-ever paid order inside this window.
    const newCustomerResult = await orderCol
      .aggregate<{ count: number }>([
        { $match: { status: { $in: REVENUE_STATUSES }, customer_email: { $ne: null } } },
        { $group: { _id: "$customer_email", first_order: { $min: "$created_at" } } },
        { $match: { first_order: { $gte: range.start, $lt: range.end } } },
        { $count: "count" },
      ])
      .toArray();

    return {
      total_sales,
      gross_sales: total_sales + discounts,
      discounts,
      orders,
      units_sold: facet?.units?.[0]?.units_sold ?? 0,
      average_order_value: orders > 0 ? Math.round(total_sales / orders) : 0,
      customers: (totals?.emails ?? []).filter((e) => e !== null && e !== undefined).length,
      new_customers: newCustomerResult[0]?.count ?? 0,
    };
  }

  async getSalesTimeseries(
    range: DateRange,
    interval: TimeseriesInterval,
    tzOffsetMinutes: number
  ): Promise<TimeseriesPoint[]> {
    const orderCol = await this.orderCol();
    const timezone = offsetToTimezone(tzOffsetMinutes);
    const date = { $dateFromString: { dateString: "$created_at" } };

    // Bucket keys must match the D1 adapter's output exactly — the route layer
    // zero-fills against keys it generates independently.
    let bucket: Record<string, unknown>;
    switch (interval) {
      case "hour":
        bucket = { $dateToString: { date, format: "%Y-%m-%dT%H:00", timezone } };
        break;
      case "week":
        bucket = {
          $dateToString: {
            date: { $dateTrunc: { date, unit: "week", startOfWeek: "monday", timezone } },
            format: "%Y-%m-%d",
            timezone,
          },
        };
        break;
      case "month":
        bucket = { $dateToString: { date, format: "%Y-%m", timezone } };
        break;
      case "day":
      default:
        bucket = { $dateToString: { date, format: "%Y-%m-%d", timezone } };
    }

    const rows = await orderCol
      .aggregate<{ _id: string; orders: number; total_sales: number; units_sold: number }>([
        { $match: this.revenueMatch(range) },
        {
          $lookup: {
            from: "order_items",
            localField: "_id",
            foreignField: "order_id",
            as: "items",
          },
        },
        { $addFields: { bucket } },
        {
          $group: {
            _id: "$bucket",
            orders: { $sum: 1 },
            total_sales: { $sum: "$amount_total" },
            units_sold: { $sum: { $sum: "$items.quantity" } },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    return rows.map((row) => ({
      bucket: row._id,
      total_sales: row.total_sales,
      orders: row.orders,
      units_sold: row.units_sold,
    }));
  }

  async getTopProducts(
    range: DateRange,
    limit: number,
    sort: TopProductSort
  ): Promise<TopProduct[]> {
    const orderCol = await this.orderCol();
    const sortField = sort === "revenue" ? "total_revenue" : "units_sold";

    const rows = await orderCol
      .aggregate<{
        _id: string;
        product_name: string;
        units_sold: number;
        total_revenue: number;
        orders: number;
      }>([
        { $match: this.revenueMatch(range) },
        {
          $lookup: {
            from: "order_items",
            localField: "_id",
            foreignField: "order_id",
            as: "items",
          },
        },
        { $unwind: "$items" },
        {
          $group: {
            _id: "$items.product_id",
            product_name: { $last: "$items.product_name" },
            units_sold: { $sum: "$items.quantity" },
            total_revenue: { $sum: { $multiply: ["$items.price", "$items.quantity"] } },
            order_ids: { $addToSet: "$_id" },
          },
        },
        {
          $project: {
            product_name: 1,
            units_sold: 1,
            total_revenue: 1,
            orders: { $size: "$order_ids" },
          },
        },
        { $sort: { [sortField]: -1 } },
        { $limit: limit },
      ])
      .toArray();

    return rows.map((row) => ({
      product_id: row._id,
      product_name: row.product_name,
      units_sold: row.units_sold,
      total_revenue: row.total_revenue,
      orders: row.orders,
    }));
  }

  async getOrderStatusCounts(range?: DateRange): Promise<OrderStatusCounts> {
    const orderCol = await this.orderCol();
    const rangeMatch = range
      ? { created_at: { $gte: range.start, $lt: range.end } }
      : {};

    const [facet] = await orderCol
      .aggregate<{
        byStatus: Array<{ _id: string; count: number }>;
        byFulfillment: Array<{ _id: string; count: number }>;
      }>([
        { $match: rangeMatch },
        {
          $facet: {
            byStatus: [{ $group: { _id: "$status", count: { $sum: 1 } } }],
            // Fulfillment counts only make sense for orders that were paid —
            // an abandoned checkout is not an order waiting to be shipped.
            byFulfillment: [
              { $match: { status: { $in: REVENUE_STATUSES } } },
              { $group: { _id: "$fulfillment_status", count: { $sum: 1 } } },
            ],
          },
        },
      ])
      .toArray();

    const counts: OrderStatusCounts = {
      pending: 0,
      paid: 0,
      fulfilled: 0,
      cancelled: 0,
      unfulfilled: 0,
      processing: 0,
      shipped: 0,
      delivered: 0,
    };

    for (const row of [...(facet?.byStatus ?? []), ...(facet?.byFulfillment ?? [])]) {
      if (row._id in counts) {
        counts[row._id as keyof OrderStatusCounts] = row.count;
      }
    }

    return counts;
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  async getSetting<T>(key: string): Promise<T | null> {
    const col = await this.settingCol();
    const doc = await col.findOne({ _id: key });
    return doc ? (doc.value as T) : null;
  }

  async setSetting<T>(key: string, value: T): Promise<T> {
    const col = await this.settingCol();
    await col.updateOne(
      { _id: key },
      { $set: { value, updated_at: new Date().toISOString() } },
      { upsert: true }
    );
    return value;
  }

  // ── Newsletter ───────────────────────────────────────────────────────────────

  async createSubscriber(input: CreateSubscriberInput): Promise<NewsletterSubscriber> {
    const col = await this.subscriberCol();
    const now = new Date().toISOString();

    const doc: MongoSubscriberDoc = {
      _id: randomUUID(),
      email: input.email.trim().toLowerCase(),
      name: input.name ?? null,
      status: "subscribed",
      source: input.source ?? "website",
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
      country: input.country ?? null,
      unsubscribe_token: randomUUID().replace(/-/g, ""),
      subscribed_at: now,
      unsubscribed_at: null,
      created_at: now,
      updated_at: now,
    };

    await col.insertOne(doc);
    return docToSubscriber(doc);
  }

  async getSubscriber(id: string): Promise<NewsletterSubscriber | null> {
    const col = await this.subscriberCol();
    const doc = await col.findOne({ _id: id });
    return doc ? docToSubscriber(doc) : null;
  }

  async getSubscriberByEmail(email: string): Promise<NewsletterSubscriber | null> {
    const col = await this.subscriberCol();
    const doc = await col.findOne({ email: email.trim().toLowerCase() });
    return doc ? docToSubscriber(doc) : null;
  }

  async getSubscriberByToken(token: string): Promise<NewsletterSubscriber | null> {
    const col = await this.subscriberCol();
    const doc = await col.findOne({ unsubscribe_token: token });
    return doc ? docToSubscriber(doc) : null;
  }

  private buildSubscriberFilter(options: SubscriberQueryOptions): Record<string, unknown> {
    const filter: Record<string, unknown> = {};
    if (options.status) filter.status = options.status;
    if (options.source) filter.source = options.source;
    if (options.search) {
      const escaped = options.search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = { $regex: escaped, $options: "i" };
      filter.$or = [{ email: pattern }, { name: pattern }];
    }
    return filter;
  }

  async getSubscribers(options: SubscriberQueryOptions = {}): Promise<NewsletterSubscriber[]> {
    const { limit = 50, offset = 0 } = options;
    const col = await this.subscriberCol();

    const docs = await col
      .find(this.buildSubscriberFilter(options))
      .sort({ created_at: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();

    return docs.map(docToSubscriber);
  }

  async countSubscribers(options: SubscriberQueryOptions = {}): Promise<number> {
    const col = await this.subscriberCol();
    return col.countDocuments(this.buildSubscriberFilter(options));
  }

  async updateSubscriber(
    id: string,
    input: UpdateSubscriberInput
  ): Promise<NewsletterSubscriber | null> {
    const col = await this.subscriberCol();
    const existing = await col.findOne({ _id: id });
    if (!existing) return null;

    const now = new Date().toISOString();
    const status = input.status ?? existing.status;

    // Stamp the opt-out moment on the transition, and clear it on re-subscribe.
    const statusFields: Partial<MongoSubscriberDoc> = {};
    if (status !== existing.status) {
      statusFields.status = status;
      if (status === "unsubscribed") {
        statusFields.unsubscribed_at = now;
      } else {
        statusFields.unsubscribed_at = null;
        statusFields.subscribed_at = now;
      }
    }

    const result = await col.findOneAndUpdate(
      { _id: id },
      {
        $set: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.tags !== undefined && { tags: input.tags }),
          ...(input.metadata !== undefined && { metadata: input.metadata }),
          ...statusFields,
          updated_at: now,
        },
      },
      { returnDocument: "after" }
    );

    return result ? docToSubscriber(result) : null;
  }

  async deleteSubscriber(id: string): Promise<boolean> {
    const col = await this.subscriberCol();
    const result = await col.deleteOne({ _id: id });
    return result.deletedCount > 0;
  }

  async getSubscriberStats(): Promise<SubscriberStats> {
    const col = await this.subscriberCol();
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [total, subscribed, unsubscribed, newLast30d] = await Promise.all([
      col.countDocuments({}),
      col.countDocuments({ status: "subscribed" }),
      col.countDocuments({ status: "unsubscribed" }),
      col.countDocuments({ created_at: { $gte: thirtyDaysAgo } }),
    ]);

    return { total, subscribed, unsubscribed, new_last_30d: newLast30d };
  }
}

/** Converts a UTC offset in minutes to the "+HH:MM" form Mongo expects. */
function offsetToTimezone(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
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

function docToSubscriber(doc: MongoSubscriberDoc): NewsletterSubscriber {
  const { _id, ...rest } = doc;
  return { id: _id, ...rest };
}
