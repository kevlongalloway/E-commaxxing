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
| `metadata` | object | Arbitrary key/value pairs — used for sizes, colors, SKUs, etc. |

---

## Product Variants (Sizes, Colors)

Variants such as clothing sizes are stored in `metadata`. There are two patterns
depending on how granular your inventory tracking needs to be.

---

### Pattern A — Sizes as metadata (simple)

Use this when you track stock at the product level (not per size).

**What the product looks like from the API:**

```json
{
  "id":    "550e8400-...",
  "name":  "Classic Tee",
  "price": 2999,
  "stock": 50,
  "metadata": {
    "sizes":      ["XS", "S", "M", "L", "XL", "XXL"],
    "size_stock": { "XS": 5, "S": 12, "M": 20, "L": 18, "XL": 8, "XXL": 3 }
  }
}
```

**Reading sizes and rendering a size picker:**

```javascript
const res     = await fetch(`/products/${productId}`);
const { data: product } = await res.json();

const sizes     = product.metadata.sizes     ?? [];
const sizeStock = product.metadata.size_stock ?? {};

// Render buttons — disable if that size is out of stock
sizes.forEach(size => {
  const qty      = sizeStock[size];
  const inStock  = qty === undefined || qty > 0;   // undefined = not tracked per-size
  const lowStock = qty !== undefined && qty <= 4;

  // e.g. React:
  // <button disabled={!inStock} onClick={() => selectSize(size)}>
  //   {size} {lowStock ? `(Only ${qty} left)` : ''}
  // </button>
});
```

**Passing the selected size through checkout:**

The selected size is not a separate `productId` in this pattern, so store it
client-side and surface it on the confirmation page. The easiest way is to
append it to `successUrl`:

```javascript
const selectedSize = 'M';

const res = await fetch('/checkout/session', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items:      [{ productId: product.id, quantity: 1 }],
    successUrl: `https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}&size=${selectedSize}`,
    cancelUrl:  'https://myshop.com/cart',
  }),
});
const { data } = await res.json();
window.location.href = data.url;
```

On the success page, read both params:
```javascript
const params    = new URLSearchParams(window.location.search);
const sessionId = params.get('session_id');
const size      = params.get('size');   // "M"

const order = await pollForOrder(sessionId);
// Display: "Classic Tee — Size M"
```

> **Admin note:** When using this pattern the admin should update
> `metadata.size_stock` manually after fulfillment, or use `stock` as the
> combined total across all sizes.

---

### Pattern B — One product per size (recommended for inventory control)

Use this when you need exact per-size stock counts tracked automatically
(stock is decremented by the webhook on every paid order).

**How products are structured in the catalog:**

```json
[
  { "id": "uuid-S", "name": "Classic Tee — S", "price": 2999, "stock": 12,
    "metadata": { "base_product": "classic-tee", "size": "S" } },
  { "id": "uuid-M", "name": "Classic Tee — M", "price": 2999, "stock": 20,
    "metadata": { "base_product": "classic-tee", "size": "M" } },
  { "id": "uuid-L", "name": "Classic Tee — L", "price": 2999, "stock": 18,
    "metadata": { "base_product": "classic-tee", "size": "L" } }
]
```

**Grouping variants into a single product card:**

```javascript
// Fetch all products
const res      = await fetch('/products?limit=100');
const { data } = await res.json();

// Group by base_product
const groups = {};
data.forEach(product => {
  const base = product.metadata.base_product;
  if (!base) {
    // Not a variant — treat as standalone product
    groups[product.id] = { product, variants: [] };
    return;
  }
  if (!groups[base]) groups[base] = { product, variants: [] };
  groups[base].variants.push(product);
});

// For each group, sort variants by size order
const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', 'XXL'];
Object.values(groups).forEach(({ variants }) => {
  variants.sort((a, b) =>
    SIZE_ORDER.indexOf(a.metadata.size) - SIZE_ORDER.indexOf(b.metadata.size)
  );
});
```

**Rendering a size picker that swaps productId:**

```javascript
function ProductCard({ group }) {
  const { product, variants } = group;
  const [selected, setSelected] = useState(null);

  // Use base product for name/images/price, variants for size selection
  const displayProduct = variants.length > 0 ? variants[0] : product;

  return (
    <div>
      <img src={getPrimaryImage(displayProduct)} alt={displayProduct.name} />
      <h2>{product.metadata.base_product ?? product.name}</h2>
      <p>{formatPrice(displayProduct.price, displayProduct.currency)}</p>

      {/* Size picker */}
      {variants.length > 0 && (
        <div className="size-picker">
          {variants.map(v => {
            const soldOut = v.stock === 0;
            const lowStock = v.stock > 0 && v.stock <= 4;
            return (
              <button
                key={v.id}
                disabled={soldOut}
                onClick={() => setSelected(v)}
                className={selected?.id === v.id ? 'active' : ''}
              >
                {v.metadata.size}
                {soldOut  ? ' — Sold out'        : ''}
                {lowStock ? ` — Only ${v.stock} left` : ''}
              </button>
            );
          })}
        </div>
      )}

      <button
        disabled={variants.length > 0 && !selected}
        onClick={() => addToCart(selected ?? product)}
      >
        {variants.length > 0 && !selected ? 'Select a size' : 'Add to cart'}
      </button>
    </div>
  );
}
```

**Checkout — pass the selected variant's productId:**

```javascript
// selected is the specific size variant product object
await fetch('/checkout/session', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items:      [{ productId: selected.id, quantity: 1 }],
    successUrl: `https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl:  'https://myshop.com/cart',
  }),
});
```

Stock is decremented automatically by the API when the webhook fires.
The `product_name` on the order will be `"Classic Tee — M"` so size is
already captured in the order record.

---

### Multi-item cart with mixed sizes

Both patterns support adding multiple sizes to a single checkout:

```javascript
const cart = [
  { productId: 'uuid-M', quantity: 1 },  // Tee in M
  { productId: 'uuid-L', quantity: 2 },  // Tee in L ×2
];

await fetch('/checkout/session', {
  method:  'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items:      cart,
    successUrl: `https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl:  'https://myshop.com/cart',
  }),
});
```

---

### Helper functions

```javascript
// Format price for display
function formatPrice(price, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(),
  }).format(price / 100);
}

// Get primary image with fallback
function getPrimaryImage(product, fallback = '/placeholder.png') {
  return product.images.length > 0 ? product.images[0] : fallback;
}

// Check if a size variant is available
function isAvailable(product) {
  return product.active && (product.stock === -1 || product.stock > 0);
}

// Stock badge text
function stockBadge(stock) {
  if (stock === 0)              return 'Sold out';
  if (stock > 0 && stock <= 4) return `Only ${stock} left`;
  return null;  // no badge needed
}
```

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
