# cloudflare-api — Skill: Build a Cloudflare Serverless API

Use this skill when the user asks to add a new route, feature, or resource to the E-commaxxing Cloudflare Workers API. This skill encodes **every pattern already used in this codebase**. Do not deviate from them.

---

## Stack

| Layer | Choice |
|-------|--------|
| Runtime | Cloudflare Workers (`nodejs_compat_v2`) |
| Framework | [Hono](https://hono.dev) v4 |
| Database | Cloudflare D1 (SQLite) **or** MongoDB Atlas — toggled by `DB_ADAPTER` |
| Payments | Stripe v17 |
| Image storage | Cloudflare R2 (optional) |
| Validation | Zod + `@hono/zod-validator` |
| Language | TypeScript (ESM, `"type": "module"`) |

---

## Project Layout

```
src/
  index.ts               # App entry — mounts middleware and all routes
  types.ts               # Bindings, Product, Database interface, ApiResponse helpers
  middleware/
    auth.ts              # adminAuthMiddleware() — JWT Bearer verification
    cors.ts              # corsMiddleware()      — CORS + preflight
    csrf.ts              # csrfMiddleware()      — Origin-based CSRF guard
  db/
    index.ts             # getDatabase(env) factory — picks D1 or Mongo
    d1.ts                # D1Database class (implements Database)
    mongo.ts             # MongoDatabase class (implements Database)
  routes/
    products.ts          # Public GET /products
    adminLogin.ts        # POST /admin/login — issues JWT
    admin.ts             # Admin CRUD /admin/products
    checkout.ts          # POST /checkout/session|intent
    webhooks.ts          # POST /webhooks/stripe
    images.ts            # Admin R2 image upload/delete
migrations/
  0001_create_products.sql
wrangler.toml
.dev.vars.example
```

---

## Bindings (`src/types.ts`)

All Cloudflare bindings and environment variables live in one `Bindings` type. **Every new binding must be added here.**

```ts
export type Bindings = {
  // D1 database (used when DB_ADAPTER = "d1")
  DB: D1Database;

  // R2 bucket for image storage
  IMAGES: R2Bucket;

  // Secrets (set via `wrangler secret put`)
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  JWT_SECRET: string;
  MONGODB_URI: string; // only required when DB_ADAPTER = "mongodb"

  // Public vars (set in wrangler.toml [vars])
  DB_ADAPTER: "d1" | "mongodb";
  MONGODB_DB_NAME: string;
  CORS_ORIGINS: string;
  CORS_METHODS: string;
  CSRF_ENABLED: string;
  STRIPE_PUBLISHABLE_KEY: string;
  DEFAULT_CURRENCY: string;
  R2_PUBLIC_URL: string;
};
```

---

## API Response Shape

All responses use the helpers defined in `src/types.ts`. **Never return raw objects** — always wrap in `ok()` or `err()`.

```ts
// Success
export type ApiSuccess<T> = { ok: true; data: T };
// Error
export type ApiError   = { ok: false; error: string; details?: unknown };

export function ok<T>(data: T): ApiSuccess<T> {
  return { ok: true, data };
}

export function err(error: string, details?: unknown): ApiError {
  return { ok: false, error, ...(details !== undefined ? { details } : {}) };
}
```

Usage in a route:
```ts
return c.json(ok(product), 201);
return c.json(err("Not found"), 404);
```

---

## Authentication

### How it works

1. Client calls `POST /admin/login` with `{ username, password }`.
2. Credentials are compared using a timing-safe byte comparison.
3. On success, a signed HS256 JWT is returned with an 8-hour TTL.
4. Every subsequent admin request includes `Authorization: Bearer <token>`.
5. `adminAuthMiddleware()` verifies the token on every protected request.

### `src/middleware/auth.ts` (exact implementation)

```ts
import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { Bindings } from "../types.js";

export const adminAuthMiddleware = (): MiddlewareHandler<{
  Bindings: Bindings;
}> => {
  return async (c, next) => {
    if (!c.env.JWT_SECRET) {
      return c.json(
        { ok: false, error: "Server misconfiguration: JWT_SECRET not set" },
        500
      );
    }

    const authHeader = c.req.header("Authorization") ?? "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return c.json(
        { ok: false, error: "Unauthorized: missing or malformed Authorization header" },
        401
      );
    }

    try {
      await verify(token.trim(), c.env.JWT_SECRET, "HS256");
    } catch {
      return c.json({ ok: false, error: "Unauthorized: invalid or expired token" }, 401);
    }
    await next();
  };
};
```

### `src/routes/adminLogin.ts` (exact implementation)

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sign } from "hono/jwt";
import type { Bindings } from "../types.js";
import { ok, err } from "../types.js";

const TOKEN_TTL = 60 * 60 * 8; // 8 hours

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const adminLogin = new Hono<{ Bindings: Bindings }>();

adminLogin.post("/", zValidator("json", loginSchema), async (c) => {
  const { username, password } = c.req.valid("json");

  if (!c.env.ADMIN_USERNAME || !c.env.ADMIN_PASSWORD || !c.env.JWT_SECRET) {
    return c.json(err("Server misconfiguration: admin credentials not set"), 500);
  }

  const validUsername = timingSafeEqual(username, c.env.ADMIN_USERNAME);
  const validPassword = timingSafeEqual(password, c.env.ADMIN_PASSWORD);

  if (!validUsername || !validPassword) {
    return c.json(err("Invalid username or password"), 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { sub: "admin", iat: now, exp: now + TOKEN_TTL },
    c.env.JWT_SECRET,
    "HS256"
  );

  return c.json(ok({ token }));
});

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0 && aBytes.length === bBytes.length;
}
```

### How routes are protected in `src/index.ts`

```ts
// Login is public — no auth required.
app.route("/admin/login", adminLogin);

// Protect all other /admin/* routes with JWT auth.
app.use("/admin/*", async (c, next) => {
  if (c.req.path === "/admin/login" || c.req.path === "/admin/login/") {
    return next();
  }
  return adminAuthMiddleware()(c, next);
});
app.route("/admin", admin);
app.route("/admin/images", images);
```

---

## Middleware Stack (`src/index.ts`)

Applied globally in this order — **do not change the order**:

```ts
app.use("*", logger());
app.use("*", secureHeaders());  // hono/secure-headers
app.use("*", corsMiddleware());
app.use("*", csrfMiddleware());
```

### CORS (`src/middleware/cors.ts`)

- Reads `CORS_ORIGINS` from env (comma-separated list or `"*"`).
- Reads `CORS_METHODS` from env.
- Handles `OPTIONS` preflight with `204 No Content`.
- Echoes `Vary: Origin` when not using wildcard.

### CSRF (`src/middleware/csrf.ts`)

- Only active when `CSRF_ENABLED = "true"`.
- Validates `Origin` header on `POST/PUT/PATCH/DELETE`.
- Requests with no `Origin` header (server-to-server, mobile) are allowed through.
- Returns `403` if Origin doesn't match `CORS_ORIGINS`.

---

## Database

### Adapter factory (`src/db/index.ts`)

```ts
export function getDatabase(env: Bindings): Database {
  const adapter = (env.DB_ADAPTER ?? "d1").toLowerCase();

  if (adapter === "mongodb") {
    if (!env.MONGODB_URI) {
      throw new Error(
        "DB_ADAPTER is set to 'mongodb' but MONGODB_URI secret is not configured. " +
          "Run: wrangler secret put MONGODB_URI"
      );
    }
    return new MongoDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME ?? "ecommaxxing");
  }

  if (!env.DB) {
    throw new Error(
      "D1 database binding 'DB' is not available. " +
        "Check your wrangler.toml [[d1_databases]] configuration."
    );
  }
  return new D1Database(env.DB);
}
```

Call it at the top of any route handler that needs data:
```ts
const db = getDatabase(c.env);
```

### Database interface (`src/types.ts`)

All adapters implement this interface — **never call D1 or Mongo directly from routes**:

```ts
export interface Database {
  getProducts(options?: ProductQueryOptions): Promise<Product[]>;
  getProduct(id: string): Promise<Product | null>;
  createProduct(input: CreateProductInput, defaultCurrency: string): Promise<Product>;
  updateProduct(id: string, input: UpdateProductInput): Promise<Product | null>;
  deleteProduct(id: string): Promise<boolean>;
  updateStripeIds(id: string, stripeProductId: string, stripePriceId: string): Promise<void>;
}
```

### D1 adapter (`src/db/d1.ts`)

- Uses parameterized prepared statements (`?1`, `?2`, …) — never string-interpolate user input.
- SQLite has no booleans: `active` is stored as `INTEGER` `1`/`0`; `rowToProduct()` converts on read.
- `images` and `metadata` are stored as JSON strings; `rowToProduct()` parses them.
- IDs are `randomUUID()` from the `crypto` module.

### D1 schema (`migrations/0001_create_products.sql`)

```sql
CREATE TABLE IF NOT EXISTS products (
  id                TEXT    PRIMARY KEY,
  name              TEXT    NOT NULL,
  description       TEXT    NOT NULL DEFAULT '',
  price             INTEGER NOT NULL,          -- smallest currency unit (cents)
  currency          TEXT    NOT NULL DEFAULT 'usd',
  images            TEXT    NOT NULL DEFAULT '[]',  -- JSON array
  metadata          TEXT    NOT NULL DEFAULT '{}',  -- JSON object
  stock             INTEGER NOT NULL DEFAULT -1,    -- -1 = unlimited
  active            INTEGER NOT NULL DEFAULT 1,     -- 1 = visible, 0 = hidden
  stripe_product_id TEXT,
  stripe_price_id   TEXT,
  created_at        TEXT    NOT NULL,
  updated_at        TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_active     ON products (active);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products (created_at DESC);
```

Apply migrations:
```bash
# Local development
wrangler d1 migrations apply blackstardb --local

# Production
wrangler d1 migrations apply blackstardb
```

### Domain model (`src/types.ts`)

```ts
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
  created_at: string;  // ISO 8601
  updated_at: string;  // ISO 8601
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

export type ProductQueryOptions = {
  limit?: number;
  offset?: number;
  activeOnly?: boolean;
};
```

---

## Wrangler Configuration (`wrangler.toml`)

```toml
name = "ecommaxxing"
main = "src/index.ts"
compatibility_date = "2025-01-01"
compatibility_flags = ["nodejs_compat_v2"]

[[d1_databases]]
binding = "DB"
database_name = "blackstardb"
database_id = "REPLACE_WITH_YOUR_D1_DATABASE_ID"

# [[r2_buckets]]
# binding = "IMAGES"
# bucket_name = "REPLACE_WITH_YOUR_R2_BUCKET_NAME"

[vars]
DB_ADAPTER         = "d1"
MONGODB_DB_NAME    = "ecommaxxing"
CORS_ORIGINS       = "*"
CORS_METHODS       = "GET,POST,PUT,DELETE,OPTIONS"
CSRF_ENABLED       = "false"
STRIPE_PUBLISHABLE_KEY = "pk_test_REPLACE_ME"
DEFAULT_CURRENCY   = "usd"
R2_PUBLIC_URL      = "REPLACE_WITH_YOUR_R2_PUBLIC_URL"
```

---

## Secrets

Stored via `wrangler secret put` — **never put in `wrangler.toml`**.

| Secret | Required | Purpose |
|--------|----------|---------|
| `ADMIN_USERNAME` | Yes | Admin login username |
| `ADMIN_PASSWORD` | Yes | Admin login password |
| `JWT_SECRET` | Yes | HS256 signing secret (`openssl rand -hex 32`) |
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key (`sk_test_…` / `sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | Yes | Stripe webhook signing secret (`whsec_…`) |
| `MONGODB_URI` | If MongoDB | MongoDB Atlas connection string |

Local dev: copy `.dev.vars.example` → `.dev.vars` (gitignored). Wrangler loads it automatically on `wrangler dev`.

```
ADMIN_USERNAME=admin
ADMIN_PASSWORD=changeme
JWT_SECRET=dev-secret-change-in-production
STRIPE_SECRET_KEY=sk_test_YOUR_TEST_KEY_HERE
STRIPE_WEBHOOK_SECRET=whsec_YOUR_WEBHOOK_SECRET_HERE
```

---

## Route Map

### Public

| Method | Path | Handler |
|--------|------|---------|
| `GET` | `/` | Health — returns `{ service, version, db }` |
| `GET` | `/health` | `{ status: "healthy" }` |
| `GET` | `/products` | List active products (paginated) |
| `GET` | `/products/:id` | Single active product |
| `POST` | `/checkout/session` | Stripe Checkout Session |
| `POST` | `/checkout/intent` | Stripe Payment Intent |
| `POST` | `/webhooks/stripe` | Stripe webhook (signature-verified) |

### Admin (JWT required)

| Method | Path | Handler |
|--------|------|---------|
| `POST` | `/admin/login` | Returns JWT |
| `GET` | `/admin/products` | List all products (incl. inactive) |
| `GET` | `/admin/products/:id` | Single product |
| `POST` | `/admin/products` | Create product |
| `PUT` | `/admin/products/:id` | Update product |
| `DELETE` | `/admin/products/:id` | Delete product |
| `POST` | `/admin/images/upload` | Upload image to R2 |
| `DELETE` | `/admin/images/:key` | Delete image from R2 |

---

## Adding a New Route (Pattern)

Follow this pattern exactly when adding a new resource:

### 1. Add types to `src/types.ts`

```ts
export type MyResource = { id: string; /* ... */ };
export type CreateMyResourceInput = { /* ... */ };
export type UpdateMyResourceInput = Partial<CreateMyResourceInput>;
```

### 2. Add methods to the `Database` interface in `src/types.ts`

```ts
export interface Database {
  // ... existing methods ...
  getMyResource(id: string): Promise<MyResource | null>;
  createMyResource(input: CreateMyResourceInput): Promise<MyResource>;
}
```

### 3. Implement in `src/db/d1.ts` (and `src/db/mongo.ts` if needed)

```ts
async getMyResource(id: string): Promise<MyResource | null> {
  const row = await this.db
    .prepare("SELECT * FROM my_resources WHERE id = ?1")
    .bind(id)
    .first<MyResourceRow>();
  return row ? rowToMyResource(row) : null;
}
```

### 4. Create `src/routes/myResource.ts`

```ts
import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { ok, err } from "../types.js";
import { getDatabase } from "../db/index.js";

const createSchema = z.object({ /* ... */ });

export const myResource = new Hono<{ Bindings: Bindings }>();

myResource.get("/", async (c) => {
  const db = getDatabase(c.env);
  const items = await db.getMyResources();
  return c.json(ok(items));
});

myResource.post("/", zValidator("json", createSchema), async (c) => {
  const input = c.req.valid("json");
  const db = getDatabase(c.env);
  const item = await db.createMyResource(input);
  return c.json(ok(item), 201);
});
```

### 5. Mount in `src/index.ts`

For a public route:
```ts
app.route("/my-resource", myResource);
```

For an admin-only route (already covered by the `/admin/*` middleware):
```ts
app.route("/admin/my-resource", myResource);
```

### 6. Write the migration

Create `migrations/0002_create_my_resources.sql` and apply it:
```bash
wrangler d1 migrations apply blackstardb --local
```

---

## npm Scripts

```bash
npm run dev              # Start local dev server (wrangler dev)
npm run deploy           # Deploy to Cloudflare Workers
npm run db:migrate       # Apply D1 migrations (production)
npm run db:migrate:local # Apply D1 migrations (local)
npm run db:studio        # Open D1 Studio
npm run setup            # Interactive setup wizard
npm run type-check       # tsc --noEmit
```

---

## Security Rules (Do Not Break)

1. **Timing-safe comparison** — always use `timingSafeEqual()` for credential checks (see `adminLogin.ts`).
2. **Parameterized queries** — use `?1`, `?2`, … positional bindings in every D1 query; never interpolate.
3. **JWT on every admin request** — `adminAuthMiddleware()` runs before all `/admin/*` handlers except `/admin/login`.
4. **Stripe webhook signature** — use `stripe.webhooks.constructEventAsync()` with the raw body; never skip.
5. **Secrets via `wrangler secret put`** — never commit real credentials to `wrangler.toml`.
6. **No raw DB calls in routes** — always go through the `Database` interface returned by `getDatabase(env)`.
