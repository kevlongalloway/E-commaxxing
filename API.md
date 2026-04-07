# E-commaxxing API — Frontend Agent Reference

**Base URL:** `https://<your-worker>.workers.dev`
**Content-Type:** `application/json` on all requests with a body.

## Response Envelope

Every endpoint returns the same wrapper:

```json
// Success
{ "ok": true, "data": <payload> }

// Error
{ "ok": false, "error": "Human-readable message" }
```

Always check `ok` before reading `data`.

## Prices

All prices are **integers in the smallest currency unit.**
`2999` with `currency: "usd"` = **$29.99**.
Never divide by 100 before sending — the API stores what you send.

---

## Products

### List products

```
GET /products
```

**Query params**

| Param | Type | Default | Max | Description |
|---|---|---|---|---|
| `limit` | integer | `50` | `100` | Results per page |
| `offset` | integer | `0` | — | Pagination offset |

**Response `data`** — array of Product objects (see schema below).

**Example**
```
GET /products?limit=12&offset=0
```

---

### Get product

```
GET /products/:id
```

Returns a single product. `404` if not found or inactive.

**Response `data`** — single Product object.

---

### Product schema

```json
{
  "id":               "550e8400-e29b-41d4-a716-446655440000",
  "name":             "Widget Pro",
  "description":      "The best widget.",
  "price":            2999,
  "currency":         "usd",
  "images":           ["https://cdn.example.com/widget.jpg"],
  "metadata":         { "sku": "WP-001", "color": "blue" },
  "stock":            42,
  "active":           true,
  "stripe_product_id": null,
  "stripe_price_id":  null,
  "created_at":       "2024-01-15T10:30:00.000Z",
  "updated_at":       "2024-01-15T10:30:00.000Z"
}
```

| Field | Type | Notes |
|---|---|---|
| `id` | string (UUID) | Stable identifier |
| `name` | string | Display name |
| `description` | string | May be empty string |
| `price` | integer | Smallest currency unit |
| `currency` | string | ISO 4217 lowercase (`"usd"`, `"eur"`) |
| `images` | string[] | CDN URLs, may be empty array |
| `metadata` | object | Arbitrary key/value pairs set by admin |
| `stock` | integer | `-1` = unlimited |
| `active` | boolean | Always `true` on public endpoints |

---

## Checkout

### Stripe Checkout Session (redirect)

Redirects the customer to a Stripe-hosted payment page.
Use this if you want Stripe to handle the UI.

```
POST /checkout/session
```

**Request body**

```json
{
  "items": [
    { "productId": "550e8400-...", "quantity": 2 }
  ],
  "successUrl": "https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}",
  "cancelUrl":  "https://myshop.com/cart"
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | array | Yes | At least one item |
| `items[].productId` | string | Yes | Must match a product `id` |
| `items[].quantity` | integer > 0 | Yes | |
| `successUrl` | string | Yes | Stripe appends `{CHECKOUT_SESSION_ID}` if included in the template |
| `cancelUrl` | string | Yes | Where to send the customer if they abandon checkout |

**Response `data`**

```json
{
  "url":       "https://checkout.stripe.com/pay/cs_test_...",
  "sessionId": "cs_test_..."
}
```

**What to do with the response:** redirect `window.location.href = data.url`.

**Error cases**

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | "Product not found: ..." | `productId` doesn't exist |
| `400` | "Product is no longer available: ..." | Product is inactive |
| `400` | "Insufficient stock for ..." | `quantity` exceeds available stock |
| `503` | "Stripe is not configured..." | Admin hasn't set Stripe keys yet |

---

### Payment Intent (custom checkout UI)

Use this when you want to build your own payment form with [Stripe Elements](https://stripe.com/docs/elements).

```
POST /checkout/intent
```

**Request body**

```json
{
  "items": [
    { "productId": "550e8400-...", "quantity": 1 }
  ]
}
```

All items must share the same currency. Mixed-currency carts are rejected.

**Response `data`**

```json
{
  "clientSecret":    "pi_3P..._secret_...",
  "paymentIntentId": "pi_3P...",
  "amount":          2999,
  "currency":        "usd",
  "publishableKey":  "pk_test_..."
}
```

| Field | Notes |
|---|---|
| `clientSecret` | Pass to `stripe.confirmPayment()` |
| `amount` | Total in smallest currency unit (informational) |
| `publishableKey` | Use to initialise `Stripe(publishableKey)` — already correct for test/live |

**Stripe Elements integration sketch**

```javascript
const res = await fetch('/checkout/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ items }),
});
const { data } = await res.json();

const stripe   = Stripe(data.publishableKey);
const elements = stripe.elements({ clientSecret: data.clientSecret });

const paymentElement = elements.create('payment');
paymentElement.mount('#payment-element');

// On form submit:
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: 'https://myshop.com/success' },
});
```

---

## HTTP Status Codes

| Status | Meaning |
|---|---|
| `200` | OK |
| `201` | Created (product created via admin) |
| `204` | No Content (CORS preflight response) |
| `400` | Bad request — check `error` field |
| `401` | Unauthorized — missing or wrong API key |
| `403` | Forbidden — CSRF check failed |
| `404` | Not found |
| `422` | Validation failed — `details` field has field-level errors |
| `500` | Server error |
| `502` | Stripe returned an error |
| `503` | Service not configured (usually missing Stripe key) |

---

## CORS

The API sends the appropriate `Access-Control-Allow-Origin` header for allowed
origins. Preflight `OPTIONS` requests are handled automatically.

If you are getting CORS errors, ask the backend operator to add your origin to
`CORS_ORIGINS` in `wrangler.toml` and redeploy.

---

## Pagination pattern

```javascript
async function getAllProducts() {
  const limit  = 50;
  let   offset = 0;
  let   all    = [];

  while (true) {
    const res  = await fetch(`/products?limit=${limit}&offset=${offset}`);
    const { ok, data } = await res.json();
    if (!ok || data.length === 0) break;
    all    = all.concat(data);
    offset += data.length;
    if (data.length < limit) break; // last page
  }
  return all;
}
```

---

## Display helpers

```javascript
// Format price for display
function formatPrice(price, currency) {
  return new Intl.NumberFormat('en-US', {
    style:    'currency',
    currency: currency.toUpperCase(),
  }).format(price / 100);
}
// formatPrice(2999, 'usd') → "$29.99"

// Check availability
function isAvailable(product) {
  return product.active && (product.stock === -1 || product.stock > 0);
}

// Build a cart item for the checkout endpoints
function toLineItem(productId, quantity) {
  return { productId, quantity };
}
```

---

## Endpoints summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/products` | — | List active products |
| `GET` | `/products/:id` | — | Single product |
| `POST` | `/checkout/session` | — | Stripe hosted checkout → get redirect URL |
| `POST` | `/checkout/intent` | — | Stripe Payment Intent → get `clientSecret` |
