# E-commaxxing — Admin Portal API Reference

**Base URL:** `https://<your-worker>.workers.dev`
**All admin routes are prefixed:** `/admin`

---

## Authentication

Admin access uses a **username + password login** that returns a short-lived JWT token.
All requests to `/admin/*` (except `/admin/login`) require this token.

### Login

```
POST /admin/login
```

**Request body**
```json
{ "username": "your-admin-username", "password": "your-admin-password" }
```

**Response `data`**
```json
{ "token": "eyJhbGci..." }
```

The token expires after **8 hours**. Store it in memory (or `sessionStorage`) and
re-login when it expires.

**Errors**

| HTTP | `error` | What happened |
|---|---|---|
| `401` | `"Invalid username or password"` | Wrong credentials |
| `500` | `"Server misconfiguration: admin credentials not set"` | Backend not configured |

---

### Attaching the token

Pass the token as a Bearer header on every subsequent request:

```
Authorization: Bearer <token>
```

```javascript
const API_BASE = 'https://<your-worker>.workers.dev';

// Login and store token
async function adminLogin(username, password) {
  const res  = await fetch(`${API_BASE}/admin/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ username, password }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  sessionStorage.setItem('adminToken', body.data.token);
}

// Authenticated fetch wrapper
async function adminFetch(path, options = {}) {
  const token = sessionStorage.getItem('adminToken');
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
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
    this.name    = 'AdminApiError';
    this.status  = status;
    this.details = details;
  }
}
```

### Auth error responses

| HTTP | `error` | What happened |
|---|---|---|
| `401` | `"Unauthorized: missing or malformed Authorization header"` | No Bearer token sent |
| `401` | `"Unauthorized: invalid or expired token"` | Token wrong or expired — re-login |
| `500` | `"Server misconfiguration: JWT_SECRET not set"` | Backend not configured |

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

## Products

### Product Schema

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

### List all products

```
GET /admin/products
```

Returns all products — including **inactive** ones.

**Query params**

| Param | Type | Default | Description |
|---|---|---|---|
| `limit` | integer | `50` | Results per page. Max `100`. |
| `offset` | integer | `0` | Pagination offset. |
| `active_only` | `"true"` \| `"false"` | `"false"` | Pass `"true"` to filter to active products only. |

**Response `data`** — array of Product objects, newest first.

---

### Get single product

```
GET /admin/products/:id
```

**Response `data`** — single Product object.

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

**Response** — `201 Created` with the full Product object.

---

### Update product

```
PUT /admin/products/:id
```

Partial update — only the fields you include are changed.

**Request body** — same fields as create, all optional.

```json
{ "price": 1999, "stock": 25, "active": true }
```

**Response `data`** — the full updated Product object.

---

### Delete product

```
DELETE /admin/products/:id
```

**Permanently** removes the product. Prefer `PUT` with `{ "active": false }` to soft-delete.

**Response `data`**
```json
{ "deleted": true }
```

---

## Image Uploads

### Upload image

```
POST /admin/images/upload
```

Accepts `multipart/form-data` with a single `file` field.
**Allowed types:** `image/jpeg`, `image/png`, `image/webp`, `image/gif`

**Response `data`**
```json
{
  "url": "https://pub-abc123.r2.dev/550e8400-e29b-41d4-a716-446655440000.jpg",
  "key": "550e8400-e29b-41d4-a716-446655440000.jpg"
}
```

### Delete image

```
DELETE /admin/images/:key
```

**Response `data`**
```json
{ "deleted": "550e8400-e29b-41d4-a716-446655440000.jpg" }
```

---

## Orders

Orders are created automatically when Stripe confirms a payment. They track the
full lifecycle from payment to delivery.

### Order Schema

```json
{
  "id":                       "a1b2c3d4-e5f6-...",
  "stripe_session_id":        "cs_test_...",
  "stripe_payment_intent_id": "pi_...",
  "status":                   "paid",
  "fulfillment_status":       "processing",
  "customer_email":           "jane@example.com",
  "customer_name":            "Jane Smith",
  "shipping_name":            "Jane Smith",
  "shipping_address_line1":   "123 Main St",
  "shipping_address_line2":   "Apt 4B",
  "shipping_city":            "Brooklyn",
  "shipping_state":           "NY",
  "shipping_postal_code":     "11201",
  "shipping_country":         "US",
  "shipping_phone":           "+1-555-555-0100",
  "shipping_carrier":         "USPS",
  "shipping_service":         "Priority Mail",
  "tracking_number":          "9400111899223397988011",
  "label_url":                "https://easypost-files.s3.amazonaws.com/files/postage_label/...",
  "amount_total":             5998,
  "currency":                 "usd",
  "metadata":                 {},
  "notes":                    "Fragile — pack carefully",
  "items": [
    {
      "id":           "item-uuid",
      "order_id":     "a1b2c3d4-...",
      "product_id":   "550e8400-...",
      "product_name": "Widget Pro",
      "price":        2999,
      "quantity":     2,
      "currency":     "usd"
    }
  ],
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T12:00:00.000Z"
}
```

#### `status` values

| Value | Meaning |
|---|---|
| `"pending"` | Payment initiated, not yet confirmed by Stripe |
| `"paid"` | Payment confirmed — order ready to fulfill |
| `"fulfilled"` | All items shipped |
| `"cancelled"` | Payment failed or order voided |

#### `fulfillment_status` values

| Value | Meaning |
|---|---|
| `"unfulfilled"` | Paid, nothing shipped yet |
| `"processing"` | Shipping label generated, packing |
| `"shipped"` | In transit — tracking number assigned |
| `"delivered"` | Carrier confirmed delivery |

---

### List orders

```
GET /admin/orders
```

**Query params**

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | integer | `50` | Max `100` |
| `offset` | integer | `0` | Pagination offset |
| `status` | string | — | Filter: `pending` \| `paid` \| `fulfilled` \| `cancelled` |
| `fulfillment_status` | string | — | Filter: `unfulfilled` \| `processing` \| `shipped` \| `delivered` |

**Response `data`** — array of Order objects, newest first.

**Examples**
```javascript
// All orders
const all = await adminFetch('/admin/orders');

// Only paid, unfulfilled orders (ready to ship)
const toShip = await adminFetch('/admin/orders?status=paid&fulfillment_status=unfulfilled');

// Recently fulfilled
const shipped = await adminFetch('/admin/orders?fulfillment_status=shipped');
```

---

### Get single order

```
GET /admin/orders/:id
```

Returns the full order including all line items.

**Response `data`** — single Order object.

**Errors**

| HTTP | Meaning |
|---|---|
| `404` | Order not found |

---

### Update order

```
PUT /admin/orders/:id
```

Partial update — only included fields are changed. Use this to:
- Advance the order status
- Add/correct tracking information manually
- Add internal notes
- Correct a shipping address before generating a label

**Request body** (all fields optional)

```json
{
  "status":                 "fulfilled",
  "fulfillment_status":     "shipped",
  "tracking_number":        "9400111899223397988011",
  "shipping_carrier":       "USPS",
  "shipping_service":       "Priority Mail",
  "notes":                  "Packed 2025-01-16. Fragile.",
  "shipping_address_line1": "456 New Ave"
}
```

| Field | Type | Notes |
|---|---|---|
| `status` | string | `pending` \| `paid` \| `fulfilled` \| `cancelled` |
| `fulfillment_status` | string | `unfulfilled` \| `processing` \| `shipped` \| `delivered` |
| `customer_email` | string \| null | |
| `customer_name` | string \| null | |
| `shipping_name` | string \| null | |
| `shipping_address_line1` | string \| null | |
| `shipping_address_line2` | string \| null | |
| `shipping_city` | string \| null | |
| `shipping_state` | string \| null | |
| `shipping_postal_code` | string \| null | |
| `shipping_country` | string \| null | 2-char ISO code |
| `shipping_phone` | string \| null | |
| `shipping_carrier` | string \| null | e.g. `"USPS"`, `"UPS"`, `"FedEx"` |
| `shipping_service` | string \| null | e.g. `"Priority Mail"` |
| `tracking_number` | string \| null | |
| `label_url` | string \| null | URL to pre-existing label |
| `notes` | string | Internal admin notes (not shown to customer) |
| `metadata` | object | Arbitrary key/value pairs |

**Response `data`** — the full updated Order object.

**Examples**
```javascript
// Mark as shipped after adding tracking manually
await adminFetch(`/admin/orders/${id}`, {
  method: 'PUT',
  body: JSON.stringify({
    fulfillment_status: 'shipped',
    tracking_number:    '9400111899223397988011',
    shipping_carrier:   'USPS',
  }),
});

// Mark fully fulfilled
await adminFetch(`/admin/orders/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ status: 'fulfilled', fulfillment_status: 'delivered' }),
});

// Cancel a problematic order
await adminFetch(`/admin/orders/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ status: 'cancelled', notes: 'Customer requested cancellation' }),
});
```

---

## Shipping Labels

Shipping labels are generated via **EasyPost** (https://www.easypost.com).
A free EasyPost account provides real USPS/UPS/FedEx labels.

**Setup:**
1. Create a free account at https://www.easypost.com
2. Copy your API key from the EasyPost dashboard
3. Run: `wrangler secret put EASYPOST_API_KEY`
4. Set your store's from-address in `wrangler.toml` (see `STORE_*` variables)
5. Apply the migration: `npm run db:migrate`

Without `EASYPOST_API_KEY`, you can still manually enter tracking numbers
via `PUT /admin/orders/:id`.

---

### Preview shipping rates

```
GET /admin/orders/:id/rates
```

Fetches available rates for an order without purchasing a label.
Use this to show rate options in the UI before committing.

**Query params**

| Param | Type | Required | Notes |
|---|---|---|---|
| `weight` | number | **Yes** | Package weight in **ounces** |
| `length` | number | No | Package length in inches |
| `width` | number | No | Package width in inches |
| `height` | number | No | Package height in inches |

**Response `data`**
```json
{
  "rates": [
    {
      "id":            "rate_abc123",
      "carrier":       "USPS",
      "service":       "Priority Mail",
      "rate":          "7.90",
      "currency":      "USD",
      "delivery_days": 2
    },
    {
      "id":            "rate_def456",
      "carrier":       "USPS",
      "service":       "First-Class Package Service",
      "rate":          "4.50",
      "currency":      "USD",
      "delivery_days": 3
    }
  ]
}
```

Rates are sorted cheapest first.

**Errors**

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | "Query param `weight` is required..." | Missing weight |
| `400` | "Order is missing a complete shipping address" | Fill in the address first |
| `404` | "Order not found" | |
| `503` | "Shipping not configured..." | EASYPOST_API_KEY not set |

**Example**
```javascript
// Preview rates for a 12-oz box (6×4×3 inches)
const { rates } = await adminFetch(
  `/admin/orders/${id}/rates?weight=12&length=6&width=4&height=3`
);
// Show rate options in the UI, then call POST .../shipping-label with carrier/service
```

---

### Generate shipping label

```
POST /admin/orders/:id/shipping-label
```

Generates and purchases a shipping label via EasyPost.
On success, the order is automatically updated with:
- `tracking_number`
- `label_url` (printable PDF)
- `shipping_carrier` and `shipping_service`
- `fulfillment_status` → `"processing"`

**Request body**

```json
{
  "parcel": {
    "weight": 12,
    "length": 6,
    "width":  4,
    "height": 3
  },
  "carrier": "USPS",
  "service": "Priority Mail"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `parcel` | object | **Yes** | Package dimensions |
| `parcel.weight` | number | **Yes** | Weight in **ounces** |
| `parcel.length` | number | No | Length in inches |
| `parcel.width` | number | No | Width in inches |
| `parcel.height` | number | No | Height in inches |
| `carrier` | string | No | e.g. `"USPS"`, `"UPS"`, `"FedEx"`. Omit to auto-select cheapest. |
| `service` | string | No | e.g. `"Priority Mail"`. Must be paired with `carrier`. |

If `carrier`/`service` are omitted, the **cheapest available rate** is automatically selected.

**Response `data`**

```json
{
  "tracking_number": "9400111899223397988011",
  "label_url":       "https://easypost-files.s3.amazonaws.com/files/postage_label/...",
  "carrier":         "USPS",
  "service":         "Priority Mail",
  "rate":            "7.90",
  "currency":        "USD",
  "delivery_days":   2,
  "rates": [ ... ],
  "order": { ... }
}
```

| Field | Notes |
|---|---|
| `tracking_number` | Use for carrier tracking page or customer notifications |
| `label_url` | Open this URL to view/print the label PDF |
| `rate` | Amount charged in USD |
| `rates` | Full list of rates that were available (useful for display) |
| `order` | The full updated order object |

**Errors**

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | "Order is missing required shipping address fields..." | Fill in address via `PUT /admin/orders/:id` |
| `400` | `"No shipping rates available for this shipment"` | Address invalid or carrier unavailable |
| `400` | `"No rate found for carrier..."` | Specified carrier/service not available — check `rates` from the preview endpoint |
| `404` | `"Order not found"` | |
| `503` | `"Shipping label generation is not configured..."` | `EASYPOST_API_KEY` not set |
| `502` | `"Failed to generate shipping label: ..."` | EasyPost API error — check address validity |

**Full workflow example**
```javascript
// Step 1: Preview rates (optional but recommended)
const { rates } = await adminFetch(
  `/admin/orders/${orderId}/rates?weight=12&length=6&width=4&height=3`
);
// Show rates to admin, let them pick one

// Step 2: Generate and purchase label
const result = await adminFetch(`/admin/orders/${orderId}/shipping-label`, {
  method: 'POST',
  body: JSON.stringify({
    parcel: { weight: 12, length: 6, width: 4, height: 3 },
    carrier: 'USPS',
    service: 'Priority Mail',
  }),
});

console.log('Label URL:', result.label_url);      // Open to print
console.log('Tracking:', result.tracking_number); // Show to customer

// Step 3: After shipping, mark as shipped
await adminFetch(`/admin/orders/${orderId}`, {
  method: 'PUT',
  body: JSON.stringify({ fulfillment_status: 'shipped' }),
});
```

---

### Manual tracking entry (no EasyPost)

If you're not using EasyPost, or you purchased a label through another service,
you can enter tracking info manually:

```javascript
await adminFetch(`/admin/orders/${orderId}`, {
  method: 'PUT',
  body: JSON.stringify({
    tracking_number:    '9400111899223397988011',
    shipping_carrier:   'USPS',
    shipping_service:   'Priority Mail',
    label_url:          'https://...',  // optional — your label PDF URL
    fulfillment_status: 'shipped',
  }),
});
```

---

## HTTP Status Codes

| Status | Meaning |
|---|---|
| `200` | OK |
| `201` | Resource created (product or image upload) |
| `400` | Bad request — check `error` field |
| `401` | Missing or invalid JWT token |
| `404` | Resource not found |
| `422` | Validation failed — `details` has field-level messages |
| `500` | Server error (or backend misconfiguration) |
| `502` | External API error (EasyPost) |
| `503` | Service not configured (missing secret key) |

---

## Pagination pattern

```javascript
async function fetchAllOrders(filters = {}) {
  const params = new URLSearchParams({ limit: 50, offset: 0, ...filters });
  const limit  = 50;
  let   offset = 0;
  let   all    = [];

  while (true) {
    params.set('limit',  limit);
    params.set('offset', offset);
    const page = await adminFetch(`/admin/orders?${params}`);
    all    = all.concat(page);
    offset += page.length;
    if (page.length < limit) break;
  }
  return all;
}

// All paid + unfulfilled orders
const toFulfill = await fetchAllOrders({ status: 'paid', fulfillment_status: 'unfulfilled' });
```

---

## Price handling

Always store and send prices as **integers in the smallest currency unit.**

```javascript
// User types "29.99" in a form input
function parsePriceInput(input, currency = 'usd') {
  const minorUnits = { usd: 2, eur: 2, gbp: 2, jpy: 0 };
  const decimals   = minorUnits[currency] ?? 2;
  return Math.round(parseFloat(input) * Math.pow(10, decimals));
}
// parsePriceInput("29.99", "usd") → 2999

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

| View | API call |
|---|---|
| Product table | `GET /admin/products` with pagination |
| Product detail / edit form | `GET /admin/products/:id` → prefill form → `PUT /admin/products/:id` |
| New product form | Form → `POST /admin/products` |
| Toggle active | `PUT /admin/products/:id` with `{ active: !current }` |
| Delete with confirmation | Confirm modal → `DELETE /admin/products/:id` |
| Image picker / uploader | `POST /admin/images/upload` → append URL → `PUT /admin/products/:id` |
| **Orders dashboard** | `GET /admin/orders` — filter by status/fulfillment_status |
| **Order detail** | `GET /admin/orders/:id` — show items, address, tracking |
| **Fulfill order** | Preview rates → `POST /admin/orders/:id/shipping-label` → print label |
| **Mark as shipped** | `PUT /admin/orders/:id` with `{ fulfillment_status: 'shipped' }` |
| **Manual tracking** | `PUT /admin/orders/:id` with tracking fields |

---

## Discounts, Sales & Promotions

Manage discount codes, time-limited sales, and product promotions.

### Discount schema

```json
{
  "id":                    "uuid",
  "code":                  "SUMMER20",
  "name":                  "Summer Sale 2024",
  "description":           "20% off all orders",
  "type":                  "percentage",
  "value":                 20,
  "applies_to":            "all",
  "product_ids":           [],
  "minimum_order_amount":  0,
  "usage_limit":           500,
  "usage_count":           37,
  "active":                true,
  "starts_at":             "2024-06-01T00:00:00Z",
  "ends_at":               "2024-08-31T23:59:59Z",
  "created_at":            "2024-05-20T10:00:00Z",
  "updated_at":            "2024-06-01T00:00:00Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `code` | string \| null | Null = automatic (no code required). String = customer must enter code. Always stored uppercase. |
| `name` | string | Internal label — shown only in admin. |
| `description` | string | Customer-facing description shown in the cart. |
| `type` | string | `"percentage"` \| `"fixed_amount"` \| `"free_shipping"` |
| `value` | integer | Percent (1–100) for `percentage`; smallest currency unit for `fixed_amount`; ignored for `free_shipping`. |
| `applies_to` | string | `"all"` = entire order; `"products"` = only the listed `product_ids`. |
| `product_ids` | string[] | Required when `applies_to = "products"`. |
| `minimum_order_amount` | integer | Minimum cart subtotal before the discount applies. `0` = no minimum. |
| `usage_limit` | integer \| null | Max redemptions. Null = unlimited. |
| `usage_count` | integer | Auto-incremented on each confirmed payment. Read-only. |
| `starts_at` | ISO 8601 \| null | Null = active immediately. |
| `ends_at` | ISO 8601 \| null | Null = never expires. |

---

### List discounts

```
GET /admin/discounts
```

**Query params**

| Param | Default | Notes |
|---|---|---|
| `limit` | `50` | Max `100` |
| `offset` | `0` | |
| `active` | — | `"true"` or `"false"` to filter |

---

### Get single discount

```
GET /admin/discounts/:id
```

---

### Create discount / sale / promo

```
POST /admin/discounts
```

**Request body**

```json
{
  "code":                  "WELCOME10",
  "name":                  "New customer 10% off",
  "description":           "10% off your first order",
  "type":                  "percentage",
  "value":                 10,
  "applies_to":            "all",
  "minimum_order_amount":  0,
  "usage_limit":           null,
  "active":                true,
  "starts_at":             null,
  "ends_at":               null
}
```

| Field | Required | Notes |
|---|---|---|
| `name` | **Yes** | Internal label |
| `type` | **Yes** | `percentage` \| `fixed_amount` \| `free_shipping` |
| `value` | **Yes** | Percent 1–100 for `percentage`; cents for `fixed_amount`; `0` for `free_shipping` |
| `code` | No | Omit or `null` for automatic discount; string for code-required |
| `description` | No | Customer-facing text |
| `applies_to` | No | `"all"` (default) or `"products"` |
| `product_ids` | Required if `applies_to = "products"` | Array of product UUIDs |
| `minimum_order_amount` | No | Default `0` |
| `usage_limit` | No | `null` = unlimited |
| `active` | No | Default `true` |
| `starts_at` / `ends_at` | No | ISO 8601 datetime strings |

**Response** — `201` with full Discount object.

**Errors**

| HTTP | `error` | |
|---|---|---|
| `409` | "Discount code '...' already exists" | Code must be unique |
| `422` | Validation failed | Check `details.fieldErrors` |

**Examples**

```javascript
// Site-wide percentage sale — no code needed, auto-expires
await adminFetch('/admin/discounts', {
  method: 'POST',
  body: JSON.stringify({
    name:        'Black Friday Sale',
    description: '25% off everything',
    type:        'percentage',
    value:       25,
    active:      true,
    starts_at:   '2024-11-29T00:00:00Z',
    ends_at:     '2024-11-30T23:59:59Z',
  }),
});

// Fixed-amount code
await adminFetch('/admin/discounts', {
  method: 'POST',
  body: JSON.stringify({
    code:        'SAVE5',
    name:        '$5 off any order',
    description: 'Save $5 on your order',
    type:        'fixed_amount',
    value:       500,   // $5.00 in cents
    usage_limit: 200,
  }),
});

// Product-scoped promotion (no code)
await adminFetch('/admin/discounts', {
  method: 'POST',
  body: JSON.stringify({
    name:        'Tee Sale',
    description: '15% off all tees',
    type:        'percentage',
    value:       15,
    applies_to:  'products',
    product_ids: ['uuid-tee-s', 'uuid-tee-m', 'uuid-tee-l'],
    starts_at:   '2024-07-01T00:00:00Z',
    ends_at:     '2024-07-07T23:59:59Z',
  }),
});

// Free shipping code
await adminFetch('/admin/discounts', {
  method: 'POST',
  body: JSON.stringify({
    code:        'FREESHIP',
    name:        'Free shipping promo',
    description: 'Free shipping on your order',
    type:        'free_shipping',
    value:       0,
  }),
});
```

---

### Update discount

```
PUT /admin/discounts/:id
```

Partial update. **`code` cannot be changed** after creation.

```javascript
// Deactivate a sale early
await adminFetch(`/admin/discounts/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ active: false }),
});

// Extend an expiry date
await adminFetch(`/admin/discounts/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ ends_at: '2024-09-30T23:59:59Z' }),
});

// Add a usage cap to an existing unlimited discount
await adminFetch(`/admin/discounts/${id}`, {
  method: 'PUT',
  body: JSON.stringify({ usage_limit: 100 }),
});
```

---

### Delete discount

```
DELETE /admin/discounts/:id
```

**Response `data`:** `{ "deleted": true }`

> Prefer deactivating (`PUT` with `{ "active": false }`) rather than deleting — orders that used the discount retain the reference.

---

## Endpoints summary

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/admin/login` | — | Login → JWT token (8 hour expiry) |
| `GET` | `/admin/products` | JWT | List all products (incl. inactive) |
| `GET` | `/admin/products/:id` | JWT | Get single product |
| `POST` | `/admin/products` | JWT | Create product → `201` |
| `PUT` | `/admin/products/:id` | JWT | Partial update |
| `DELETE` | `/admin/products/:id` | JWT | Hard delete |
| `POST` | `/admin/images/upload` | JWT | Upload image to R2 → `201` with `{ url, key }` |
| `DELETE` | `/admin/images/:key` | JWT | Delete image from R2 |
| `GET` | `/admin/orders` | JWT | List all orders (filterable by status) |
| `GET` | `/admin/orders/:id` | JWT | Get single order with line items |
| `PUT` | `/admin/orders/:id` | JWT | Update order (status, tracking, address, notes) |
| `GET` | `/admin/orders/:id/rates` | JWT | Preview shipping rates (EasyPost) |
| `POST` | `/admin/orders/:id/shipping-label` | JWT | Generate & purchase shipping label (EasyPost) |
| `GET` | `/admin/discounts` | JWT | List all discounts / sales / promos |
| `GET` | `/admin/discounts/:id` | JWT | Get single discount |
| `POST` | `/admin/discounts` | JWT | Create discount / sale / promo → `201` |
| `PUT` | `/admin/discounts/:id` | JWT | Update (cannot change code) |
| `DELETE` | `/admin/discounts/:id` | JWT | Delete discount |
