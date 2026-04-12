# E-commaxxing API — Frontend Reference

**Base URL:** `https://<your-worker>.workers.dev`
**Content-Type:** `application/json` on all requests with a body.

> **Version 1.2 changes (frontend team — action required):**
> - Both checkout endpoints now accept an optional `discountCode` field — pass the code the customer typed in.
> - New public endpoint: `POST /discounts/validate` — validate a code and preview savings before redirecting to checkout.
> - Both checkout responses now include `discount_amount`, `original_amount`, `final_amount`, and `is_free_shipping` fields.
> - New public endpoint: `GET /orders?session_id=` — lets customers look up their order status and tracking info after checkout.
> - `POST /checkout/session` now collects shipping address automatically via Stripe. `POST /checkout/intent` accepts optional `shippingAddress` field.

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

## Discounts, Sales & Promotions

The API supports three kinds of discounts:

| Kind | How it works | When to use |
|---|---|---|
| **Discount code** | Customer types a code (e.g. `SUMMER20`). Pass `discountCode` in the checkout body. | Coupon campaigns, influencer codes |
| **Automatic sale** | Applied without a code — triggered by a date range. | Site-wide or product sales |
| **Automatic promotion** | Same as a sale but scoped to specific products. | Category or product promotions |

---

### Validate a discount code

```
POST /discounts/validate
```

Call this when the customer clicks "Apply" on a discount code field, **before** they go to checkout. Shows the savings amount so you can update the cart total in real time.

Also returns any currently active automatic discounts (sales/promotions) with no code required — useful for showing sale banners on the cart page.

**Request body**

```json
{
  "code": "SUMMER20",
  "items": [
    { "productId": "550e8400-...", "price": 2999, "quantity": 2 }
  ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `code` | string | No | Discount code entered by the customer. Omit to check automatic discounts only. |
| `items` | array | Yes | Cart items with `productId`, `price` (unit price integer), and `quantity` |

> The `price` in items should match `product.price` from the catalog — do not format or convert it.

**Response `data`** — valid code

```json
{
  "valid":            true,
  "discount": {
    "id":                   "uuid",
    "code":                 "SUMMER20",
    "name":                 "Summer Sale 2024",
    "description":          "20% off all orders",
    "type":                 "percentage",
    "value":                20,
    "ends_at":              "2024-08-31T23:59:59Z",
    "minimum_order_amount": 0,
    "discount_amount":      1200
  },
  "discount_amount":  1200,
  "original_amount":  5998,
  "final_amount":     4798,
  "is_free_shipping": false,
  "automatic_discounts": []
}
```

**Response `data`** — invalid code

```json
{
  "valid":            false,
  "error":            "This discount has expired",
  "discount":         null,
  "discount_amount":  0,
  "original_amount":  5998,
  "final_amount":     5998,
  "automatic_discounts": []
}
```

| Field | Type | Notes |
|---|---|---|
| `valid` | boolean | Whether the code is valid and applies to this cart |
| `error` | string | Human-readable reason when `valid: false` |
| `discount_amount` | integer | Amount saved in smallest currency unit |
| `original_amount` | integer | Cart subtotal before discount |
| `final_amount` | integer | Amount customer will be charged |
| `is_free_shipping` | boolean | Whether the discount grants free shipping |
| `automatic_discounts` | array | Active sales/promotions that apply without a code |

**Error cases**

| HTTP | `error` | Meaning |
|---|---|---|
| `400` | "Body must include `items` array..." | Missing or invalid items |

---

### Applying a discount at checkout

Pass `discountCode` in the body of either checkout endpoint. If no code is provided, active automatic discounts (sales/promos) are applied automatically.

**Stripe hosted checkout (`/checkout/session`)**

```javascript
const res = await fetch('/checkout/session', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [{ productId: '550e8400-...', quantity: 2 }],
    successUrl: 'https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}',
    cancelUrl:  'https://myshop.com/cart',
    discountCode: 'SUMMER20',   // ← add this
  }),
});
const { data } = await res.json();
// data.discount_amount  → e.g. 1200  ($12.00 saved)
// data.original_amount  → e.g. 5998
// data.final_amount     → e.g. 4798
window.location.href = data.url;
```

**Custom checkout (`/checkout/intent`)**

```javascript
const res = await fetch('/checkout/intent', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    items: [{ productId: '550e8400-...', quantity: 2 }],
    discountCode:    'SUMMER20',
    shippingAddress: { ... },
  }),
});
const { data } = await res.json();
// data.amount now reflects the discounted total
// data.discount_amount, original_amount, final_amount are also returned
```

If the code is invalid or doesn't apply, the endpoint returns a `400` error — validate with `/discounts/validate` first for a better UX.

---

### Recommended discount UX flow

```javascript
let appliedDiscount = null;

async function applyCode(code) {
  const res = await fetch('/discounts/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, items: cartItems }),
  });
  const { data } = await res.json();

  if (!data.valid) {
    showError(data.error);   // e.g. "This discount has expired"
    return;
  }

  appliedDiscount = data;
  updateCartUI({
    original:  formatPrice(data.original_amount, currency),
    discount:  `-${formatPrice(data.discount_amount, currency)}`,
    total:     formatPrice(data.final_amount, currency),
    badge:     data.discount.description,  // e.g. "20% off all orders"
    shipping:  data.is_free_shipping ? 'FREE' : null,
  });
}

async function proceedToCheckout() {
  const res = await fetch('/checkout/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: cartItems,
      successUrl: 'https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}',
      cancelUrl:  'https://myshop.com/cart',
      discountCode: appliedDiscount?.discount.code ?? undefined,
    }),
  });
  const { data } = await res.json();
  window.location.href = data.url;
}
```

---

### Showing automatic sales on the product page

Call `/discounts/validate` with your cart items (omit `code`) to find any active sales:

```javascript
async function getActiveSales(productId, price) {
  const res = await fetch('/discounts/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{ productId, price, quantity: 1 }],
    }),
  });
  const { data } = await res.json();
  return data.automatic_discounts;
}

// Show a "SUMMER SALE — 20% OFF" badge on the product card
const sales = await getActiveSales(product.id, product.price);
if (sales.length > 0) {
  showSaleBadge(sales[0].description);
  showSalePrice(formatPrice(product.price - sales[0].discount_amount, product.currency));
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
| `POST` | `/checkout/session` | — | Stripe hosted checkout → get redirect URL (supports `discountCode`) |
| `POST` | `/checkout/intent` | — | Stripe Payment Intent → get `clientSecret` (supports `discountCode`) |
| `POST` | `/discounts/validate` | — | Validate a discount code or preview automatic discounts |
| `GET` | `/orders?session_id=` | — | Look up order status and tracking by Stripe session ID |
