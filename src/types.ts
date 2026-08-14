// ─── Cloudflare Worker Bindings ───────────────────────────────────────────────

export type Bindings = {
  // D1 database (used when DB_ADAPTER = "d1")
  DB: D1Database;

  // R2 bucket for image storage
  IMAGES: R2Bucket;

  // ── Secrets (set via `wrangler secret put`) ──
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  MONGODB_URI: string;       // only required when DB_ADAPTER = "mongodb"
  EASYPOST_API_KEY: string;  // optional — enables automatic shipping label generation

  // ── Public vars (set in wrangler.toml [vars]) ──
  DB_ADAPTER: "d1" | "mongodb";
  MONGODB_DB_NAME: string;
  CORS_ORIGINS: string;
  CORS_METHODS: string;
  CSRF_ENABLED: string;
  STRIPE_PUBLISHABLE_KEY: string;
  DEFAULT_CURRENCY: string;
  R2_PUBLIC_URL: string;

  // Store / from-address used when generating shipping labels
  STORE_NAME: string;
  STORE_ADDRESS_LINE1: string;
  STORE_ADDRESS_LINE2: string;
  STORE_CITY: string;
  STORE_STATE: string;
  STORE_POSTAL_CODE: string;
  STORE_COUNTRY: string;
  STORE_PHONE: string;

  // Comma-separated ISO 3166-1 alpha-2 codes, or "*" for all countries.
  SHIPPING_COUNTRIES: string;
};

// ─── Domain Models — Products ─────────────────────────────────────────────────

export type Product = {
  id: string;
  name: string;
  description: string;
  /** Price in smallest currency unit (e.g. cents). 1000 = $10.00 */
  price: number;
  currency: string;
  images: string[];
  metadata: Record<string, unknown>;
  /** -1 means unlimited */
  stock: number;
  active: boolean;
  stripe_product_id: string | null;
  stripe_price_id: string | null;
  /** Custom display order for products (ascending). 0 = first */
  display_order: number;
  created_at: string;
  updated_at: string;
};

export type CreateProductInput = {
  name: string;
  description?: string;
  price: number;
  currency?: string;
  images?: string[];
  metadata?: Record<string, unknown>;
  stock?: number;
  active?: boolean;
};

export type UpdateProductInput = Partial<CreateProductInput>;

// ─── Domain Models — Orders ───────────────────────────────────────────────────

/** Tracks payment lifecycle. */
export type OrderStatus = "pending" | "paid" | "fulfilled" | "cancelled";

/** Tracks shipping/fulfillment lifecycle. */
export type FulfillmentStatus = "unfulfilled" | "processing" | "shipped" | "delivered";

export type OrderItem = {
  id: string;
  order_id: string;
  product_id: string;
  product_name: string;
  /** Unit price at the time of purchase, in smallest currency unit. */
  price: number;
  quantity: number;
  currency: string;
};

export type Order = {
  id: string;
  stripe_session_id: string | null;
  stripe_payment_intent_id: string | null;
  status: OrderStatus;
  fulfillment_status: FulfillmentStatus;
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
  /** ID of the discount applied to this order, if any. */
  discount_id: string | null;
  /** Code entered by the customer, or null for automatic discounts. */
  discount_code: string | null;
  /** Amount discounted in smallest currency unit. */
  discount_amount: number;
  metadata: Record<string, unknown>;
  notes: string;
  items: OrderItem[];
  created_at: string;
  updated_at: string;
};

export type CreateOrderInput = {
  stripe_session_id?: string | null;
  stripe_payment_intent_id?: string | null;
  status?: OrderStatus;
  customer_email?: string | null;
  customer_name?: string | null;
  shipping_name?: string | null;
  shipping_address_line1?: string | null;
  shipping_address_line2?: string | null;
  shipping_city?: string | null;
  shipping_state?: string | null;
  shipping_postal_code?: string | null;
  shipping_country?: string | null;
  shipping_phone?: string | null;
  amount_total: number;
  currency: string;
  discount_id?: string | null;
  discount_code?: string | null;
  discount_amount?: number;
  metadata?: Record<string, unknown>;
  notes?: string;
  items: Array<{
    product_id: string;
    product_name: string;
    price: number;
    quantity: number;
    currency: string;
  }>;
};

export type UpdateOrderInput = {
  status?: OrderStatus;
  fulfillment_status?: FulfillmentStatus;
  customer_email?: string | null;
  customer_name?: string | null;
  shipping_name?: string | null;
  shipping_address_line1?: string | null;
  shipping_address_line2?: string | null;
  shipping_city?: string | null;
  shipping_state?: string | null;
  shipping_postal_code?: string | null;
  shipping_country?: string | null;
  shipping_phone?: string | null;
  shipping_carrier?: string | null;
  shipping_service?: string | null;
  tracking_number?: string | null;
  label_url?: string | null;
  notes?: string;
  metadata?: Record<string, unknown>;
};

export type OrderSortField = "created_at" | "amount_total";
export type SortDirection = "asc" | "desc";

export type OrderQueryOptions = {
  limit?: number;
  offset?: number;
  status?: OrderStatus;
  fulfillment_status?: FulfillmentStatus;
  /** Inclusive lower bound on created_at (ISO 8601). */
  start_date?: string;
  /** Exclusive upper bound on created_at (ISO 8601). */
  end_date?: string;
  /** Case-insensitive substring match on customer email, name, or order ID. */
  search?: string;
  sort?: OrderSortField;
  direction?: SortDirection;
};

// ─── Domain Models — Discounts ────────────────────────────────────────────────

/** How the discount value is applied. */
export type DiscountType = "percentage" | "fixed_amount" | "free_shipping";

/** Which products qualify for the discount. */
export type DiscountAppliesTo = "all" | "products";

export type Discount = {
  id: string;
  /** Null = automatic discount (sale/promo). String = customer must enter this code. */
  code: string | null;
  /** Internal label shown only in the admin portal. */
  name: string;
  /** Optional customer-facing description, e.g. "20% off summer styles". */
  description: string;
  type: DiscountType;
  /** Percentage (1–100) for "percentage"; smallest currency unit for "fixed_amount". */
  value: number;
  applies_to: DiscountAppliesTo;
  /** Product UUIDs this discount applies to. Empty = all products (when applies_to = "all"). */
  product_ids: string[];
  /** Minimum order subtotal (before discount) in smallest currency unit. 0 = no minimum. */
  minimum_order_amount: number;
  /** Maximum number of times this discount can be used. Null = unlimited. */
  usage_limit: number | null;
  usage_count: number;
  active: boolean;
  /** ISO 8601. Null = active immediately. */
  starts_at: string | null;
  /** ISO 8601. Null = never expires. */
  ends_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateDiscountInput = {
  code?: string | null;
  name: string;
  description?: string;
  type: DiscountType;
  value: number;
  applies_to?: DiscountAppliesTo;
  product_ids?: string[];
  minimum_order_amount?: number;
  usage_limit?: number | null;
  active?: boolean;
  starts_at?: string | null;
  ends_at?: string | null;
};

export type UpdateDiscountInput = Partial<Omit<CreateDiscountInput, "code">>;

export type DiscountQueryOptions = {
  limit?: number;
  offset?: number;
  active?: boolean;
};

/**
 * The result of validating and calculating a discount against a cart.
 */
export type AppliedDiscount = {
  discount: Discount;
  /** Actual amount saved, in smallest currency unit. */
  discount_amount: number;
  original_amount: number;
  final_amount: number;
};

// ─── Domain Models — Newsletter ───────────────────────────────────────────────

export type SubscriberStatus = "subscribed" | "unsubscribed";

export type NewsletterSubscriber = {
  id: string;
  /** Always stored lowercased and trimmed. */
  email: string;
  name: string | null;
  status: SubscriberStatus;
  /** Where the signup came from, e.g. "footer", "popup", "checkout". */
  source: string;
  tags: string[];
  metadata: Record<string, unknown>;
  /** ISO 3166-1 alpha-2 country from the Cloudflare edge, when available. */
  country: string | null;
  /** Unguessable token for one-click unsubscribe links. */
  unsubscribe_token: string;
  subscribed_at: string;
  unsubscribed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type CreateSubscriberInput = {
  email: string;
  name?: string | null;
  source?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  country?: string | null;
};

export type UpdateSubscriberInput = {
  name?: string | null;
  status?: SubscriberStatus;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

export type SubscriberQueryOptions = {
  limit?: number;
  offset?: number;
  status?: SubscriberStatus;
  source?: string;
  /** Case-insensitive substring match on email or name. */
  search?: string;
};

export type SubscriberStats = {
  total: number;
  subscribed: number;
  unsubscribed: number;
  /** Signups in the last 30 days. */
  new_last_30d: number;
};

// ─── Domain Models — Analytics ────────────────────────────────────────────────

/** A half-open time window: start inclusive, end exclusive. Both ISO 8601. */
export type DateRange = {
  start: string;
  end: string;
};

/** Bucket size for the sales-over-time chart. */
export type TimeseriesInterval = "hour" | "day" | "week" | "month";

/**
 * Aggregate sales figures for a date range.
 * All money values are in the smallest currency unit (cents).
 *
 * Only orders with status "paid" or "fulfilled" count toward revenue —
 * "pending" (checkout started, never completed) and "cancelled" are excluded.
 */
export type SalesMetrics = {
  /** Sum of amount_total — what customers actually paid. */
  total_sales: number;
  /** total_sales + discounts — revenue before discounts were applied. */
  gross_sales: number;
  /** Sum of discount_amount across counted orders. */
  discounts: number;
  /** Number of revenue-counting orders. */
  orders: number;
  /** Sum of line-item quantities across counted orders. */
  units_sold: number;
  /** total_sales / orders, rounded to the nearest cent. 0 when no orders. */
  average_order_value: number;
  /** Distinct customer emails that placed a counted order in the range. */
  customers: number;
  /** Customers whose first-ever paid order landed inside this range. */
  new_customers: number;
};

/** One point on the sales-over-time chart. */
export type TimeseriesPoint = {
  /**
   * Bucket key in the requested timezone:
   *   hour  → "2026-08-14T09:00"
   *   day   → "2026-08-14"
   *   week  → "2026-08-10"  (the Monday starting that week)
   *   month → "2026-08"
   */
  bucket: string;
  total_sales: number;
  orders: number;
  units_sold: number;
};

/** One row of the "top products" table. */
export type TopProduct = {
  product_id: string;
  product_name: string;
  units_sold: number;
  /** Line-item revenue (unit price × quantity), pre-discount. */
  total_revenue: number;
  /** Number of distinct orders containing this product. */
  orders: number;
};

export type TopProductSort = "units" | "revenue";

/** Order counts by payment status and fulfillment status. */
export type OrderStatusCounts = {
  pending: number;
  paid: number;
  fulfilled: number;
  cancelled: number;
  unfulfilled: number;
  processing: number;
  shipped: number;
  delivered: number;
};

export type AnalyticsQueryOptions = {
  /** Minutes to shift UTC by when bucketing, e.g. -420 for UTC-07:00. */
  tz_offset_minutes?: number;
};

// ─── Database Adapter Interface ───────────────────────────────────────────────

export type ProductQueryOptions = {
  limit?: number;
  offset?: number;
  activeOnly?: boolean;
};

export interface Database {
  // ── Products ──
  getProducts(options?: ProductQueryOptions): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  createProduct(input: CreateProductInput, defaultCurrency: string): Promise<Product>;
  updateProduct(id: string, input: UpdateProductInput): Promise<Product | null>;
  deleteProduct(id: string): Promise<boolean>;
  updateStripeIds(id: string, stripeProductId: string, stripePriceId: string): Promise<void>;
  reorderProducts(updates: Array<{ id: string; display_order: number }>): Promise<Product[]>;

  // ── Orders ──
  createOrder(input: CreateOrderInput): Promise<Order>;
  getOrder(id: string): Promise<Order | null>;
  getOrderByStripeSession(sessionId: string): Promise<Order | null>;
  getOrderByStripeIntent(intentId: string): Promise<Order | null>;
  getOrders(options?: OrderQueryOptions): Promise<Order[]>;
  /** Total number of orders matching the same filters, ignoring limit/offset. */
  countOrders(options?: OrderQueryOptions): Promise<number>;
  updateOrder(id: string, input: UpdateOrderInput): Promise<Order | null>;

  // ── Analytics ──
  getSalesMetrics(range: DateRange): Promise<SalesMetrics>;
  getSalesTimeseries(
    range: DateRange,
    interval: TimeseriesInterval,
    tzOffsetMinutes: number
  ): Promise<TimeseriesPoint[]>;
  getTopProducts(range: DateRange, limit: number, sort: TopProductSort): Promise<TopProduct[]>;
  /** Status counts. Pass a range to scope them, or omit for all-time. */
  getOrderStatusCounts(range?: DateRange): Promise<OrderStatusCounts>;

  // ── Discounts ──
  createDiscount(input: CreateDiscountInput): Promise<Discount>;
  getDiscount(id: string): Promise<Discount | null>;
  getDiscountByCode(code: string): Promise<Discount | null>;
  getDiscounts(options?: DiscountQueryOptions): Promise<Discount[]>;
  getActiveAutomaticDiscounts(): Promise<Discount[]>;
  updateDiscount(id: string, input: UpdateDiscountInput): Promise<Discount | null>;
  deleteDiscount(id: string): Promise<boolean>;
  incrementDiscountUsage(id: string): Promise<void>;

  // ── Newsletter ──
  createSubscriber(input: CreateSubscriberInput): Promise<NewsletterSubscriber>;
  getSubscriber(id: string): Promise<NewsletterSubscriber | null>;
  getSubscriberByEmail(email: string): Promise<NewsletterSubscriber | null>;
  getSubscriberByToken(token: string): Promise<NewsletterSubscriber | null>;
  getSubscribers(options?: SubscriberQueryOptions): Promise<NewsletterSubscriber[]>;
  countSubscribers(options?: SubscriberQueryOptions): Promise<number>;
  updateSubscriber(id: string, input: UpdateSubscriberInput): Promise<NewsletterSubscriber | null>;
  deleteSubscriber(id: string): Promise<boolean>;
  getSubscriberStats(): Promise<SubscriberStats>;
}

// ─── Discount calculation helper ──────────────────────────────────────────────

/**
 * Validates whether a discount is currently active and returns the discount
 * amount for the given cart. Returns null if the discount is not applicable.
 *
 * @param discount - The discount to evaluate.
 * @param items    - Cart items with product_id, price (unit), and quantity.
 * @param subtotal - Pre-discount order subtotal in smallest currency unit.
 */
export function calculateDiscountAmount(
  discount: Discount,
  items: Array<{ product_id: string; price: number; quantity: number }>,
  subtotal: number
): number {
  const now = new Date().toISOString();

  if (!discount.active) return 0;
  if (discount.starts_at && now < discount.starts_at) return 0;
  if (discount.ends_at && now > discount.ends_at) return 0;
  if (discount.usage_limit !== null && discount.usage_count >= discount.usage_limit) return 0;
  if (discount.minimum_order_amount > 0 && subtotal < discount.minimum_order_amount) return 0;

  if (discount.type === "free_shipping") return 0; // Recorded but no monetary value

  // Determine qualifying subtotal.
  let qualifying = subtotal;
  if (discount.applies_to === "products" && discount.product_ids.length > 0) {
    const ids = new Set(discount.product_ids);
    qualifying = items.reduce(
      (sum, item) => (ids.has(item.product_id) ? sum + item.price * item.quantity : sum),
      0
    );
    if (qualifying === 0) return 0;
  }

  if (discount.type === "percentage") {
    return Math.round(qualifying * discount.value / 100);
  }
  // fixed_amount — cap at qualifying subtotal so total never goes negative.
  return Math.min(discount.value, qualifying);
}

// ─── API Response helpers ─────────────────────────────────────────────────────

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiError = { ok: false; error: string; details?: unknown };
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function err(error: string, details?: unknown): ApiError {
  return { ok: false, error, ...(details !== undefined ? { details } : {}) };
}
