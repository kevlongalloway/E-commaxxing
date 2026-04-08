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
  MONGODB_URI: string; // only required when DB_ADAPTER = "mongodb"

  // ── Public vars (set in wrangler.toml [vars]) ──
  DB_ADAPTER: "d1" | "mongodb";
  MONGODB_DB_NAME: string;
  CORS_ORIGINS: string;
  CORS_METHODS: string;
  CSRF_ENABLED: string;
  STRIPE_PUBLISHABLE_KEY: string;
  DEFAULT_CURRENCY: string;
  R2_PUBLIC_URL: string;
};

// ─── Domain Models ────────────────────────────────────────────────────────────

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

// ─── Database Adapter Interface ───────────────────────────────────────────────

export type ProductQueryOptions = {
  limit?: number;
  offset?: number;
  activeOnly?: boolean;
};

export interface Database {
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
