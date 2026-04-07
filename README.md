# E-commaxxing — Serverless E-commerce Backend

A fully-featured e-commerce API backend running on **Cloudflare Workers** (serverless). Zero servers to manage, globally distributed, and cheap to run.

---

## Feature Overview

| Feature | Details |
|---|---|
| **Runtime** | Cloudflare Workers (serverless edge) |
| **Framework** | [Hono](https://hono.dev) — lightweight, built for the edge |
| **Database** | Cloudflare D1 (SQLite) **or** MongoDB Atlas |
| **Payments** | Stripe Checkout Sessions & Payment Intents |
| **CORS** | Configurable allowed origins |
| **CSRF** | Optional Origin-header check |
| **Admin API** | Full product CRUD, protected by API key |
| **Public API** | Read-only product catalog |

---

## Prerequisites

- **Node.js** 18+ ([nodejs.org](https://nodejs.org))
- **Wrangler** (Cloudflare's CLI): `npm install -g wrangler`
- A **Cloudflare account** (free tier works) — [dash.cloudflare.com](https://dash.cloudflare.com)
- A **Stripe account** — [dashboard.stripe.com](https://dashboard.stripe.com)

---

## Quick Setup (Recommended)

The setup script handles everything interactively:

```bash
# 1. Clone and install dependencies
git clone <your-repo> e-commaxxing
cd e-commaxxing
npm install

# 2. Run the interactive setup
npm run setup
```

The script will:
1. Check you're logged in to Cloudflare (`wrangler login` if not)
2. Create a D1 database (or configure MongoDB)
3. Ask for your Stripe keys and CORS settings
4. Write your `wrangler.toml` configuration
5. Push secrets to Cloudflare via `wrangler secret put`
6. Run database migrations
7. Optionally deploy immediately

---

## Manual Setup

If you prefer to configure things yourself:

### 1. Install dependencies

```bash
npm install
```

### 2. Create a D1 database (skip if using MongoDB)

```bash
wrangler d1 create ecommaxxing-db
```

Copy the `database_id` from the output and paste it into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "ecommaxxing-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # ← paste here
```

### 3. Configure `wrangler.toml`

Open `wrangler.toml` and set the `[vars]` section:

```toml
[vars]
DB_ADAPTER        = "d1"          # or "mongodb"
CORS_ORIGINS      = "https://myshop.com"
CORS_METHODS      = "GET,POST,PUT,DELETE,OPTIONS"
CSRF_ENABLED      = "false"
STRIPE_PUBLISHABLE_KEY = "pk_test_..."
DEFAULT_CURRENCY  = "usd"
```

### 4. Set secrets

Secrets are sensitive values that should never appear in `wrangler.toml`.

```bash
# Required
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put ADMIN_API_KEY

# Required only if DB_ADAPTER = "mongodb"
wrangler secret put MONGODB_URI
```

When prompted, paste the value and press Enter.

### 5. Run database migrations (D1 only)

```bash
# Apply migrations to your deployed D1 database
npm run db:migrate

# Apply migrations locally (for development)
npm run db:migrate:local
```

### 6. Local development

```bash
# Create a .dev.vars file for local secrets
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your test keys

npm run dev
# → http://localhost:8787
```

### 7. Deploy

```bash
npm run deploy
```

---

## Configuration Reference

### `wrangler.toml` Variables

These are non-sensitive and checked into source control.

| Variable | Default | Description |
|---|---|---|
| `DB_ADAPTER` | `"d1"` | `"d1"` for Cloudflare D1, `"mongodb"` for MongoDB Atlas |
| `MONGODB_DB_NAME` | `"ecommaxxing"` | MongoDB database name (only used when `DB_ADAPTER = "mongodb"`) |
| `CORS_ORIGINS` | `"*"` | Comma-separated allowed origins, or `*` for all |
| `CORS_METHODS` | `"GET,POST,PUT,DELETE,OPTIONS"` | Allowed HTTP methods |
| `CSRF_ENABLED` | `"false"` | `"true"` to enable Origin-header CSRF check |
| `STRIPE_PUBLISHABLE_KEY` | — | Your Stripe publishable key (`pk_test_...` or `pk_live_...`) |
| `DEFAULT_CURRENCY` | `"usd"` | ISO 4217 currency code for new products |

### Secrets (via `wrangler secret put`)

| Secret | Required | Description |
|---|---|---|
| `STRIPE_SECRET_KEY` | Yes | Stripe secret key (`sk_test_...` or `sk_live_...`) |
| `STRIPE_WEBHOOK_SECRET` | Yes (for webhooks) | Stripe webhook signing secret (`whsec_...`) |
| `ADMIN_API_KEY` | Yes | API key for admin endpoints — generate any random string |
| `MONGODB_URI` | If using MongoDB | MongoDB Atlas connection string |

---

## API Reference

Base URL: `https://<your-worker>.workers.dev`

All responses follow this shape:

```json
// Success
{ "ok": true, "data": { ... } }

// Error
{ "ok": false, "error": "Description of what went wrong" }
```

Prices are always in the **smallest currency unit** (cents for USD, pence for GBP, etc.).
`1000` = $10.00 USD.

---

### Public Endpoints

No authentication required.

#### `GET /`

Health check / info.

```json
{ "ok": true, "data": { "service": "e-commaxxing", "version": "1.0.0", "db": "d1" } }
```

---

#### `GET /products`

List all active products.

**Query parameters:**

| Param | Default | Description |
|---|---|---|
| `limit` | `50` | Number of results (max 100) |
| `offset` | `0` | Pagination offset |

**Example:**
```bash
curl https://my-worker.workers.dev/products?limit=10&offset=0
```

**Response:**
```json
{
  "ok": true,
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "name": "Widget Pro",
      "description": "The best widget you'll ever buy.",
      "price": 2999,
      "currency": "usd",
      "images": ["https://cdn.example.com/widget.jpg"],
      "metadata": { "sku": "WP-001", "weight_kg": 0.5 },
      "stock": 42,
      "active": true,
      "stripe_product_id": null,
      "stripe_price_id": null,
      "created_at": "2024-01-15T10:30:00.000Z",
      "updated_at": "2024-01-15T10:30:00.000Z"
    }
  ]
}
```

---

#### `GET /products/:id`

Get a single product by ID.

```bash
curl https://my-worker.workers.dev/products/550e8400-e29b-41d4-a716-446655440000
```

---

#### `POST /checkout/session`

Create a Stripe Checkout Session. The customer is redirected to a Stripe-hosted payment page.

**Request body:**
```json
{
  "items": [
    { "productId": "550e8400-...", "quantity": 2 }
  ],
  "successUrl": "https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}",
  "cancelUrl":  "https://myshop.com/cart"
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "url": "https://checkout.stripe.com/pay/cs_test_...",
    "sessionId": "cs_test_..."
  }
}
```

**Frontend usage (redirect):**
```javascript
const res = await fetch('/checkout/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items, successUrl, cancelUrl }),
});
const { data } = await res.json();
window.location.href = data.url;
```

---

#### `POST /checkout/intent`

Create a Stripe Payment Intent for a **custom payment form** using [Stripe Elements](https://stripe.com/docs/elements).

**Request body:**
```json
{
  "items": [
    { "productId": "550e8400-...", "quantity": 1 }
  ]
}
```

**Response:**
```json
{
  "ok": true,
  "data": {
    "clientSecret": "pi_3P..._secret_...",
    "paymentIntentId": "pi_3P...",
    "amount": 2999,
    "currency": "usd",
    "publishableKey": "pk_test_..."
  }
}
```

**Frontend usage (Stripe Elements):**
```javascript
const { data } = await (await fetch('/checkout/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items }),
})).json();

const stripe = Stripe(data.publishableKey);
const elements = stripe.elements({ clientSecret: data.clientSecret });
// Mount a Payment Element, then call stripe.confirmPayment(...)
```

---

#### `POST /webhooks/stripe`

Receives Stripe webhook events. Must be registered in the Stripe dashboard.

**How to set up webhooks:**

1. Go to [Stripe Dashboard → Developers → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **"Add endpoint"**
3. URL: `https://<your-worker>.workers.dev/webhooks/stripe`
4. Events to select:
   - `checkout.session.completed`
   - `payment_intent.succeeded`
   - `payment_intent.payment_failed`
5. Copy the **Signing secret** (`whsec_...`)
6. Run: `wrangler secret put STRIPE_WEBHOOK_SECRET`

**Local webhook testing with Stripe CLI:**
```bash
stripe listen --forward-to http://localhost:8787/webhooks/stripe
```

The Stripe CLI will print a webhook secret to use in `.dev.vars`.

---

### Admin Endpoints

All admin endpoints require:

```
Authorization: Bearer <ADMIN_API_KEY>
```

---

#### `GET /admin/products`

List all products (including inactive).

**Query parameters:**

| Param | Default | Description |
|---|---|---|
| `limit` | `50` | Number of results |
| `offset` | `0` | Pagination offset |
| `active_only` | `false` | `true` to show only active products |

---

#### `GET /admin/products/:id`

Get a single product (including inactive).

---

#### `POST /admin/products`

Create a new product.

```bash
curl -X POST https://my-worker.workers.dev/admin/products \
  -H "Authorization: Bearer your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Widget Pro",
    "description": "The best widget.",
    "price": 2999,
    "currency": "usd",
    "images": ["https://cdn.example.com/widget.jpg"],
    "metadata": { "sku": "WP-001" },
    "stock": 100,
    "active": true
  }'
```

**Body fields:**

| Field | Required | Type | Description |
|---|---|---|---|
| `name` | Yes | string | Product name (1–255 chars) |
| `price` | Yes | integer | Price in smallest unit (e.g. 2999 = $29.99) |
| `description` | No | string | Product description |
| `currency` | No | string | 3-letter ISO code. Defaults to `DEFAULT_CURRENCY` |
| `images` | No | string[] | Array of image URLs |
| `metadata` | No | object | Any extra key/value pairs |
| `stock` | No | integer | Inventory count. `-1` = unlimited |
| `active` | No | boolean | Whether the product appears in public API |

---

#### `PUT /admin/products/:id`

Update a product. All fields are optional — only the ones you send will change.

```bash
curl -X PUT https://my-worker.workers.dev/admin/products/550e8400-... \
  -H "Authorization: Bearer your-admin-key" \
  -H "Content-Type: application/json" \
  -d '{ "price": 1999, "stock": 50 }'
```

**Tip:** To hide a product from the public catalog without deleting it:
```json
{ "active": false }
```

---

#### `DELETE /admin/products/:id`

Permanently delete a product. Consider using `PUT` with `active: false` instead
to preserve history.

```bash
curl -X DELETE https://my-worker.workers.dev/admin/products/550e8400-... \
  -H "Authorization: Bearer your-admin-key"
```

---

## Database

### Cloudflare D1 (default)

D1 is Cloudflare's built-in SQLite database. It's:
- **Zero configuration** — no external accounts needed
- **Free** for small workloads (5 GB storage, 5M rows read/day on free plan)
- **Globally replicated** reads

D1 is the recommended option unless you already have a MongoDB cluster.

**Schema location:** `migrations/0001_create_products.sql`

**Useful commands:**
```bash
# Apply migrations to production
npm run db:migrate

# Apply migrations locally
npm run db:migrate:local

# Open the D1 Studio (browser-based SQL editor)
npm run db:studio

# Run raw SQL
wrangler d1 execute ecommaxxing-db --command "SELECT * FROM products"
```

### MongoDB Atlas

To use MongoDB instead:

1. Set `DB_ADAPTER = "mongodb"` in `wrangler.toml`
2. Set `MONGODB_DB_NAME` to your database name
3. Set the `MONGODB_URI` secret: `wrangler secret put MONGODB_URI`
4. Your connection string looks like:
   `mongodb+srv://username:password@cluster.mongodb.net/`

> **Note:** The MongoDB adapter uses the `mongodb` npm package with `nodejs_compat_v2`.
> Make sure your Atlas cluster allows connections from Cloudflare's IP ranges (or set it to allow all IPs: `0.0.0.0/0` for development).

---

## CORS & CSRF

### CORS

Configure which frontend origins can call your API.

**Allow a specific origin (production-recommended):**
```toml
CORS_ORIGINS = "https://myshop.com"
```

**Allow multiple origins:**
```toml
CORS_ORIGINS = "https://myshop.com,https://www.myshop.com,https://staging.myshop.com"
```

**Allow all origins (development only):**
```toml
CORS_ORIGINS = "*"
```

### CSRF

CSRF protection validates the `Origin` header on non-GET requests.

```toml
CSRF_ENABLED = "true"
CORS_ORIGINS = "https://myshop.com"   # only this origin is allowed
```

**When to enable CSRF:**
- Your frontend uses **browser cookies** for authentication
- You want to prevent malicious websites from tricking users' browsers

**When to leave it disabled:**
- You're calling the API from server-side code (no Origin header)
- You're using `Authorization: Bearer` headers (CSRF doesn't apply — headers aren't automatically sent by browsers)
- You're building a mobile app

---

## Deploying to Production

```bash
# Make sure you have the latest dependencies
npm install

# Deploy
npm run deploy
```

Your worker will be available at:
- `https://e-commaxxing.<your-subdomain>.workers.dev` (default)
- Or a custom domain if configured in the Cloudflare dashboard

**Switching from test to live Stripe keys:**
```bash
wrangler secret put STRIPE_SECRET_KEY      # enter sk_live_...
wrangler secret put STRIPE_WEBHOOK_SECRET  # enter new webhook secret for live endpoint
```
Update `STRIPE_PUBLISHABLE_KEY` in `wrangler.toml` to `pk_live_...`, then redeploy.

---

## Project Structure

```
e-commaxxing/
├── src/
│   ├── index.ts              # Main app — middleware, routing
│   ├── types.ts              # Shared types & Bindings
│   ├── middleware/
│   │   ├── cors.ts           # CORS headers
│   │   ├── csrf.ts           # Origin-based CSRF check
│   │   └── auth.ts           # Admin API key auth
│   ├── db/
│   │   ├── index.ts          # DB adapter factory
│   │   ├── d1.ts             # Cloudflare D1 adapter
│   │   └── mongo.ts          # MongoDB adapter
│   └── routes/
│       ├── products.ts       # GET /products, GET /products/:id
│       ├── admin.ts          # Admin CRUD for products
│       ├── checkout.ts       # Stripe checkout & payment intents
│       └── webhooks.ts       # Stripe webhook handler
├── migrations/
│   └── 0001_create_products.sql
├── setup.mjs                 # Interactive setup script
├── wrangler.toml             # Cloudflare Worker config
├── .dev.vars.example         # Template for local secrets
└── package.json
```

---

## Troubleshooting

### "D1 database binding 'DB' is not available"
Your `wrangler.toml` is missing the correct `database_id`. Run:
```bash
wrangler d1 list
```
Copy the ID and update `wrangler.toml → [[d1_databases]] → database_id`.

### "ADMIN_API_KEY not set"
The secret was not pushed to Cloudflare. Run:
```bash
wrangler secret put ADMIN_API_KEY
```

### Stripe webhook returns 400 "Invalid webhook signature"
- Make sure you're using the signing secret for the correct endpoint (test vs live).
- The secret starts with `whsec_`.
- During local dev, use `stripe listen --forward-to localhost:8787/webhooks/stripe` to get the correct local secret.

### MongoDB connection timeout
- Check your Atlas cluster's **Network Access** settings — Cloudflare Workers use dynamic IPs so you'll need to allow `0.0.0.0/0`.
- Check your `MONGODB_URI` secret is set: `wrangler secret list`.

### CORS errors in the browser
- Make sure `CORS_ORIGINS` includes your frontend's exact origin (with protocol, no trailing slash).
- Check that preflight `OPTIONS` requests are getting a `204` response.

---

## Adding Order Fulfillment

The webhook handler in `src/routes/webhooks.ts` has `TODO` comments where you'd add fulfillment logic. For example:

```typescript
case "checkout.session.completed": {
  const session = event.data.object as Stripe.Checkout.Session;
  const productIds = session.metadata?.product_ids?.split(",") ?? [];

  // Decrement stock, create an order record, send a confirmation email, etc.
  break;
}
```

---

## License

MIT
