# E-commaxxing — Admin Portal API Reference

**Base URL:** `https://<your-worker>.workers.dev`
**All admin routes are prefixed:** `/admin`

---

## Authentication

Every request to `/admin/*` must include the API key as a Bearer token:

```
Authorization: Bearer <ADMIN_API_KEY>
```

The key is set by the backend operator during setup (`wrangler secret put ADMIN_API_KEY`).

**Store the key securely.** Do not expose it in client-side JavaScript, commit it
to source control, or log it. The recommended pattern is to keep it in an
environment variable on your portal server and proxy requests server-side, or
store it in a secure secrets manager.

### Auth error responses

| HTTP | `error` | What happened |
|---|---|---|
| `401` | `"Unauthorized: missing or malformed Authorization header"` | Header is absent or not in `Bearer <token>` format |
| `401` | `"Unauthorized: invalid API key"` | Wrong key |
| `500` | `"Server misconfiguration: ADMIN_API_KEY not set"` | Backend is not configured — contact the backend operator |

### How to attach the header

```javascript
// Recommended: build a single authenticated fetch wrapper
const API_BASE = 'https://<your-worker>.workers.dev';

async function adminFetch(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.ADMIN_API_KEY}`,
      ...options.headers,
    },
  });

  const body = await res.json();

  if (!res.ok || !body.ok) {
    throw new AdminApiError(body.error ?? 'Unknown error', res.status, body.details);
  }

  return body.data;
}

class AdminApiError extends Error {
  constructor(message, status, details) {
    super(message);
    this.name  = 'AdminApiError';
    this.status  = status;
    this.details = details; // present on 422 validation errors
  }
}
```

---

## Response Envelope

Identical to the public API.

```json
// Success
{ "ok": true, "data": <payload> }

// Error
{ "ok": false, "error": "Human-readable message" }

// Validation failure (422 only)
{ "ok": false, "error": "Validation failed", "details": { "fieldErrors": {}, "formErrors": [] } }
```

---

## Product Schema

Admins see all fields including inactive products.

```json
{
  "id":                "550e8400-e29b-41d4-a716-446655440000",
  "name":              "Widget Pro",
  "description":       "The best widget.",
  "price":             2999,
  "currency":          "usd",
  "images":            ["https://cdn.example.com/widget.jpg"],
  "metadata":          { "sku": "WP-001", "weight_kg": 0.5 },
  "stock":             42,
  "active":            false,
  "stripe_product_id": null,
  "stripe_price_id":   null,
  "created_at":        "2024-01-15T10:30:00.000Z",
  "updated_at":        "2024-01-16T08:00:00.000Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Server-generated. Never send on create. |
| `name` | string | 1–255 characters |
| `description` | string | Up to 5,000 characters. Empty string if not set. |
| `price` | integer | **Smallest currency unit.** `2999` = $29.99 USD. Must be ≥ 1. |
| `currency` | string | ISO 4217 lowercase (`"usd"`, `"eur"`, `"gbp"`). 3 characters. |
| `images` | string[] | Array of fully-qualified URLs. Can be empty. |
| `metadata` | object | Any JSON key/value pairs for internal use (SKUs, dimensions, tags, etc.) |
| `stock` | integer | `-1` = unlimited. `0` = sold out. Any positive integer = exact count. |
| `active` | boolean | `false` hides the product from the public catalog. |
| `stripe_product_id` | string \| null | Set by Stripe after first purchase. Read-only from the portal. |
| `stripe_price_id` | string \| null | Same. Read-only. |
| `created_at` | ISO 8601 string | Set by server. |
| `updated_at` | ISO 8601 string | Updated by server on every write. |

---

## Endpoints

### List all products

```
GET /admin/products
```

Returns all products — including **inactive** ones. Use this for the main
product table in the portal.

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Results per page. Max `100`. |
| `offset` | integer | `0` | Pagination offset. |
| `active_only` | `"true"` \| `"false"` | `"false"` | Pass `"true"` to filter to active products only. |

**Response `data`** — array of Product objects, newest first.

**Example**
```javascript
// Page 1 of all products (including drafts)
const products = await adminFetch('/admin/products?limit=50&offset=0');

// Only active products
const active = await adminFetch('/admin/products?active_only=true');
```

---

### Get single product

```
GET /admin/products/:id
```

Returns a product by its UUID, including if it is inactive.

**Response `data`** — single Product object.

**Example**
```javascript
const product = await adminFetch('/admin/products/550e8400-e29b-41d4-a716-446655440000');
```

**Errors**

| HTTP | Meaning |
|---|---|
| `404` | No product with that ID |

---

### Create product

```
POST /admin/products
```

**Request body**

```json
{
  "name":        "Widget Pro",
  "price":       2999,
  "description": "The best widget.",
  "currency":    "usd",
  "images":      ["https://cdn.example.com/widget.jpg"],
  "metadata":    { "sku": "WP-001" },
  "stock":       100,
  "active":      true
}
```

| Field | Required | Type | Constraints | Default |
|---|---|---|---|---|
| `name` | **Yes** | string | 1–255 chars | — |
| `price` | **Yes** | integer | Positive, smallest currency unit | — |
| `description` | No | string | Max 5,000 chars | `""` |
| `currency` | No | string | 3-char ISO 4217 lowercase | Server's `DEFAULT_CURRENCY` |
| `images` | No | string[] | Each must be a valid URL | `[]` |
| `metadata` | No | object | Any JSON object | `{}` |
| `stock` | No | integer | `-1` or any positive integer | `-1` (unlimited) |
| `active` | No | boolean | | `true` |

**Response** — `201 Created` with the full Product object including its new `id`.

**Example**
```javascript
const newProduct = await adminFetch('/admin/products', {
  method: 'POST',
  body: JSON.stringify({
    name:  'Widget Pro',
    price: 2999,
    stock: 50,
  }),
});
console.log(newProduct.id); // UUID assigned by server
```

**Errors**

| HTTP | `error` | Meaning |
|---|---|---|
| `422` | `"Validation failed"` | One or more fields failed validation. Check `details.fieldErrors`. |

**Validation error shape**
```json
{
  "ok": false,
  "error": "Validation failed",
  "details": {
    "fieldErrors": {
      "price": ["Price must be an integer (smallest currency unit, e.g. cents)"],
      "name":  ["String must contain at least 1 character(s)"]
    },
    "formErrors": []
  }
}
```

---

### Update product

```
PUT /admin/products/:id
```

Partial update — only the fields you include are changed. Fields you omit
are left exactly as they are.

**Request body** — same fields as create, all optional.

```json
{ "price": 1999, "stock": 25, "active": true }
```

**Response `data`** — the full updated Product object.

**Example**
```javascript
// Reduce price
const updated = await adminFetch(`/admin/products/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ price: 1999 }),
});

// Hide from public without deleting
await adminFetch(`/admin/products/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ active: false }),
});

// Mark as sold out
await adminFetch(`/admin/products/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ stock: 0 }),
});

// Restore and restock
await adminFetch(`/admin/products/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ active: true, stock: 50 }),
});
```

**Errors**

| HTTP | Meaning |
|---|---|
| `404` | No product with that ID |
| `422` | Validation failed (same shape as create) |

---

### Delete product

```
DELETE /admin/products/:id
```

**Permanently** removes the product from the database. This cannot be undone.

> **Prefer `PUT` with `{ "active": false }` for most cases.** Soft-deleting
> (deactivating) keeps the product ID stable so past checkout references don't
> break. Hard delete when you are certain the product is unused.

**Response `data`**
```json
{ "deleted": true }
```

**Example**
```javascript
await adminFetch(`/admin/products/${id}`, { method: 'DELETE' });
```

**Errors**

| HTTP | Meaning |
|---|---|
| `404` | No product with that ID (already deleted or wrong ID) |

---

## Image Uploads

Images are stored in Cloudflare R2. Upload an image first to get a URL, then
pass that URL in the `images` array when creating or updating a product.

> **Requires R2 to be configured.** See `wrangler.toml` for setup instructions.

---

### Upload image

```
POST /admin/images/upload
```

Accepts a `multipart/form-data` request with a single `file` field.

**Allowed file types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`

**Response `data`**
```json
{
  "url": "https://pub-abc123.r2.dev/550e8400-e29b-41d4-a716-446655440000.jpg",
  "key": "550e8400-e29b-41d4-a716-446655440000.jpg"
}
```

| Field | Description |
|---|---|
| `url` | Fully-qualified public URL — pass this directly into a product's `images` array |
| `key` | R2 object key — use this if you need to delete the image later |

**Example**
```javascript
async function uploadImage(file) {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${API_BASE}/admin/images/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.ADMIN_API_KEY}` },
    body: form,
    // Do NOT set Content-Type manually — the browser sets it with the boundary
  });

  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body.data; // { url, key }
}

// Upload then attach to a product
const { url } = await uploadImage(fileInput.files[0]);
await adminFetch(`/admin/products/${productId}`, {
  method: 'PUT',
  body: JSON.stringify({ images: [url] }),
});
```

**Errors**

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | `"Missing \"file\" field"` | No file included in the form |
| `400` | `"Invalid file type ..."` | File type not allowed |
| `400` | `"Request must be multipart/form-data"` | Wrong content type |
| `500` | `"R2 bucket not configured"` | `IMAGES` binding missing — check wrangler.toml |

---

### Delete image

```
DELETE /admin/images/:key
```

Deletes an image from R2 by its key (returned from the upload endpoint).

**Response `data`**
```json
{ "deleted": "550e8400-e29b-41d4-a716-446655440000.jpg" }
```

**Example**
```javascript
await adminFetch(`/admin/images/${key}`, { method: 'DELETE' });
```

> **Note:** Deleting an image from R2 does not remove its URL from any products.
> Update or delete the product separately if needed.

---

## HTTP Status Codes

| Status | Meaning |
|---|---|
| `200` | OK |
| `201` | Product created |
| `401` | Missing or invalid API key |
| `404` | Product not found |
| `422` | Validation failed — `details` has field-level messages |
| `500` | Server error (or backend misconfiguration) |

---

## Pagination pattern

```javascript
async function fetchAllProducts() {
  const limit  = 50;
  let   offset = 0;
  let   all    = [];

  while (true) {
    const page = await adminFetch(`/admin/products?limit=${limit}&offset=${offset}`);
    all    = all.concat(page);
    offset += page.length;
    if (page.length < limit) break;
  }
  return all;
}
```

---

## Price handling

Always store and send prices as **integers in the smallest currency unit.**
Apply formatting only at display time.

```javascript
// User types "29.99" in a form input
function parsePriceInput(input, currency = 'usd') {
  const minorUnits = { usd: 2, eur: 2, gbp: 2, jpy: 0 };
  const decimals   = minorUnits[currency] ?? 2;
  return Math.round(parseFloat(input) * Math.pow(10, decimals));
}
// parsePriceInput("29.99", "usd") → 2999
// parsePriceInput("1000",  "jpy") → 1000

// Display price from API
function formatPrice(price, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(),
  }).format(price / 100);
}
// formatPrice(2999, 'usd') → "$29.99"
```

---

## Stock conventions

| `stock` value | Meaning | What to show |
|---|---|---|
| `-1` | Unlimited / not tracked | "In stock" or no badge |
| `0` | Sold out | "Sold out" badge |
| `1–4` | Low stock | "Only N left" warning |
| `5+` | Normal | "In stock" or quantity |

---

## Recommended portal views

These are suggestions — build whatever fits your workflow.

| View | API call |
|---|---|
| Product table | `GET /admin/products` with pagination |
| Product detail / edit form | `GET /admin/products/:id` → prefill form → `PUT /admin/products/:id` |
| New product form | Form → `POST /admin/products` |
| Toggle active | `PUT /admin/products/:id` with `{ active: !current }` |
| Bulk deactivate | Loop `PUT /admin/products/:id` with `{ active: false }` for each selected ID |
| Delete with confirmation | Confirm modal → `DELETE /admin/products/:id` |

---

## Endpoints summary

| Method | Path | Description |
|---|---|---|
| `GET` | `/admin/products` | List all products (incl. inactive) |
| `GET` | `/admin/products/:id` | Get single product |
| `POST` | `/admin/products` | Create product → `201` |
| `PUT` | `/admin/products/:id` | Partial update |
| `DELETE` | `/admin/products/:id` | Hard delete |
| `POST` | `/admin/images/upload` | Upload image to R2 → `201` with `{ url, key }` |
| `DELETE` | `/admin/images/:key` | Delete image from R2 |
