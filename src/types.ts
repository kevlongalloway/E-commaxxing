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
  STORE_COUNTRY: string;    // ISO 3166-1 alpha-2, e.g. "US"
  STORE_PHONE: string;

  // Comma-separated ISO 3166-1 alpha-2 codes, or "*" for all countries.
  // Controls which countries Stripe Checkout will collect shipping addresses for.
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
  /** Carrier name, e.g. "USPS", "UPS", "FedEx" */
  shipping_carrier: string | null;
  /** Service level, e.g. "Priority Mail", "Ground" */
  shipping_service: string | null;
  tracking_number: string | null;
  /** Public or pre-signed URL to the printable label PDF */
  label_url: string | null;
  /** Order total in smallest currency unit */
  amount_total: number;
  currency: string;
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

export type OrderQueryOptions = {
  limit?: number;
  offset?: number;
  status?: OrderStatus;
  fulfillment_status?: FulfillmentStatus;
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
  updateStripeIds(
    id: string,
    stripeProductId: string,
    stripePriceId: string
  ): Promise<void>;

  // ── Orders ──
  createOrder(input: CreateOrderInput): Promise<Order>;
  getOrder(id: string): Promise<Order | null>;
  getOrderByStripeSession(sessionId: string): Promise<Order | null>;
  getOrderByStripeIntent(intentId: string): Promise<Order | null>;
  getOrders(options?: OrderQueryOptions): Promise<Order[]>;
  updateOrder(id: string, input: UpdateOrderInput): Promise<Order | null>;
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
