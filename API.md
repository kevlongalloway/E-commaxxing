# E-commaxxing API — Frontend Reference

**Base URL:** `https://<your-worker>.workers.dev`
**Content-Type:** `application/json` on all requests with a body.

> **Version 1.1 changes (frontend team — action required):**
> - `POST /checkout/session` now collects a shipping address from the customer on the Stripe-hosted page. No frontend changes needed for this flow; Stripe handles it automatically.
> - `POST /checkout/intent` accepts an optional `shippingAddress` body field for custom checkout UIs. See the [Payment Intent section](#payment-intent-custom-checkout-ui) for the new field.
> - New public endpoint: `GET /orders/:id` — lets a logged-in customer look up their order status and tracking info after checkout.

---

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
| `images` | string[] | CDN URLs, may be empty array. First entry is the primary/thumbnail image. |
| `metadata` | object | Arbitrary key/value pairs set by admin |
| `stock` | integer | `-1` = unlimited |
| `active` | boolean | Always `true` on public endpoints |

---

## Checkout

### Stripe Checkout Session (redirect)

Redirects the customer to a Stripe-hosted payment page.
Stripe will collect the customer's **shipping address and phone number** automatically
during the checkout flow — no extra frontend work required.

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

After the customer completes payment, Stripe calls the webhook and an order is
automatically created in the database with status `"paid"`. The `sessionId` can
be used to look up the order via `GET /orders?session_id={sessionId}`.

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
When using this flow, collect the customer's shipping address in your form and
pass it in `shippingAddress` so it is stored on the order.

```
POST /checkout/intent
```

**Request body**

```json
{
  "items": [
    { "productId": "550e8400-...", "quantity": 1 }
  ],
  "shippingAddress": {
    "name":       "Jane Smith",
    "line1":      "123 Main St",
    "line2":      "Apt 4B",
    "city":       "Brooklyn",
    "state":      "NY",
    "postalCode": "11201",
    "country":    "US",
    "phone":      "+1-555-555-0100"
  }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `items` | array | Yes | At least one item |
| `items[].productId` | string | Yes | |
| `items[].quantity` | integer > 0 | Yes | |
| `shippingAddress` | object | No | Strongly recommended — enables order tracking and shipping labels |
| `shippingAddress.name` | string | No | Recipient name |
| `shippingAddress.line1` | string | **Yes if shippingAddress present** | Street address |
| `shippingAddress.line2` | string | No | Apt/Suite |
| `shippingAddress.city` | string | **Yes if shippingAddress present** | |
| `shippingAddress.state` | string | No | State/province/region |
| `shippingAddress.postalCode` | string | **Yes if shippingAddress present** | |
| `shippingAddress.country` | string | **Yes if shippingAddress present** | ISO 3166-1 alpha-2, e.g. `"US"` |
| `shippingAddress.phone` | string | No | |

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

**Stripe Elements integration**

```javascript
// 1. Collect items and shipping address from your form, then:
const res = await fetch('/checkout/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items,
    shippingAddress: {
      name:       form.name,
      line1:      form.address,
      city:       form.city,
      state:      form.state,
      postalCode: form.zip,
      country:    form.country,
      phone:      form.phone,
    },
  }),
});
const { data } = await res.json();

// 2. Initialize Stripe
const stripe   = Stripe(data.publishableKey);
const elements = stripe.elements({ clientSecret: data.clientSecret });

const paymentElement = elements.create('payment');
paymentElement.mount('#payment-element');

// 3. On form submit:
const { error } = await stripe.confirmPayment({
  elements,
  confirmParams: { return_url: 'https://myshop.com/success' },
});
```

---

## Order Status (customer-facing)

After a successful payment, customers can look up their order status and
tracking information. The recommended flow is:

1. On the success page, extract the `session_id` query param from Stripe's
   redirect URL (e.g. `?session_id=cs_test_...`).
2. Call `GET /orders?session_id={session_id}` to show order details.

### Look up order by Stripe session

```
GET /orders?session_id=cs_test_...
```

**Query params**

| Param | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | Yes | The `{CHECKOUT_SESSION_ID}` from the Stripe success URL |

**Response `data`** — Order object (see schema below).

Returns `404` if no order has been created yet (the webhook may still be
processing — retry after 2–3 seconds).

**Example — success page**

```javascript
// successUrl was: "https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}"
const params = new URLSearchParams(window.location.search);
const sessionId = params.get('session_id');

async function pollForOrder(sessionId, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const res  = await fetch(`/orders?session_id=${sessionId}`);
    const body = await res.json();
    if (body.ok) return body.data;
    if (res.status !== 404) throw new Error(body.error);
    // 404 means webhook hasn't fired yet — wait and retry
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error('Order not found after multiple attempts');
}

const order = await pollForOrder(sessionId);
showOrderConfirmation(order);
```

---

### Order schema

```json
{
  "id":                       "a1b2c3d4-...",
  "stripe_session_id":        "cs_test_...",
  "stripe_payment_intent_id": "pi_...",
  "status":                   "paid",
  "fulfillment_status":       "unfulfilled",
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
  "label_url":                null,
  "amount_total":             2999,
  "currency":                 "usd",
  "metadata":                 {},
  "notes":                    "",
  "items": [
    {
      "id":           "item-uuid",
      "order_id":     "a1b2c3d4-...",
      "product_id":   "550e8400-...",
      "product_name": "Widget Pro",
      "price":        2999,
      "quantity":     1,
      "currency":     "usd"
    }
  ],
  "created_at": "2024-01-15T10:30:00.000Z",
  "updated_at": "2024-01-15T12:00:00.000Z"
}
```

#### Order status values

| `status` | Meaning | What to show customer |
|---|---|---|
| `"pending"` | Payment initiated, not yet confirmed | "Processing…" |
| `"paid"` | Payment confirmed by Stripe | "Order confirmed!" |
| `"fulfilled"` | All items shipped | "Order shipped!" |
| `"cancelled"` | Payment failed or order voided | "Order cancelled" |

#### Fulfillment status values

| `fulfillment_status` | Meaning | What to show customer |
|---|---|---|
| `"unfulfilled"` | Paid, not yet shipped | "Preparing your order" |
| `"processing"` | Shipping label generated, packing | "Your order is being packed" |
| `"shipped"` | Label scanned / in transit | "Your order is on the way!" |
| `"delivered"` | Carrier confirmed delivery | "Your order has been delivered" |

#### Tracking

When the order has a `tracking_number`, display it prominently.
You can link to the carrier's tracking page:

```javascript
function trackingUrl(carrier, trackingNumber) {
  const carriers = {
    USPS:  `https://tools.usps.com/go/TrackConfirmAction?tLabels=${trackingNumber}`,
    UPS:   `https://www.ups.com/track?tracknum=${trackingNumber}`,
    FedEx: `https://www.fedex.com/fedextrack/?tracknumbers=${trackingNumber}`,
    DHL:   `https://www.dhl.com/en/express/tracking.html?AWB=${trackingNumber}`,
  };
  return carriers[carrier] ?? `https://google.com/search?q=${carrier}+tracking+${trackingNumber}`;
}
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
| `502` | Stripe or EasyPost returned an error |
| `503` | Service not configured (usually missing Stripe or EasyPost key) |

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

// Images — the `images` field is always an array, may be empty.
// The first entry is treated as the primary/thumbnail image.
// Always guard against an empty array.
function getPrimaryImage(product, fallback = '/placeholder.png') {
  return product.images.length > 0 ? product.images[0] : fallback;
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
| `GET` | `/orders?session_id=` | — | Look up order by Stripe session ID (post-checkout) |
