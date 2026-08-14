# Dashboard & Newsletter API — Frontend Integration Guide

Everything the admin dashboard needs to render a Shopify-style overview, plus the
public newsletter signup endpoint for the storefront.

**Base URL:** `https://<your-worker>.workers.dev`

> **Before this works in production:** run `npm run db:migrate` to apply
> `migrations/0005_create_newsletter_and_analytics_indexes.sql`. Without it the
> newsletter endpoints return `500`.

---

## Table of contents

1. [Conventions](#conventions)
2. [Auth](#auth)
3. [Date range parameters](#date-range-parameters) — shared by every analytics endpoint
4. [`GET /admin/analytics/dashboard`](#get-adminanalyticsdashboard) — one call, whole page
5. [`GET /admin/analytics/overview`](#get-adminanalyticsoverview) — KPI cards
6. [`GET /admin/analytics/timeseries`](#get-adminanalyticstimeseries) — sales chart
7. [`GET /admin/analytics/top-products`](#get-adminanalyticstop-products)
8. [`GET /admin/orders`](#get-adminorders-updated) — now paginated, searchable, sortable
9. [Public newsletter endpoints](#public-newsletter-endpoints)
10. [Admin newsletter endpoints](#admin-newsletter-endpoints)
11. [Display helpers](#display-helpers)
12. [Suggested dashboard layout](#suggested-dashboard-layout)

---

## Conventions

**Response envelope** — unchanged from the rest of the API:

```jsonc
{ "ok": true,  "data": <payload> }
{ "ok": false, "error": "Human-readable message" }
{ "ok": false, "error": "Validation failed", "details": { "fieldErrors": {}, "formErrors": [] } }  // 422
```

List endpoints add a **sibling** `pagination` key next to `data` (not inside it),
so existing code that reads `data` keeps working:

```jsonc
{
  "ok": true,
  "data": [ /* … */ ],
  "pagination": { "total": 137, "limit": 50, "offset": 0, "has_more": true }
}
```

**Money is always an integer in the smallest currency unit** (cents). `5000` = $50.00.
Divide by 100 for display — never do math on the formatted string.

**What counts as revenue:** only orders with `status` of `paid` or `fulfilled`.
Orders that are `pending` (checkout started, never paid) or `cancelled` are
excluded from every sales figure. They still appear in `order_counts` so you can
show them separately.

---

## Auth

Every `/admin/*` endpoint needs the JWT from `POST /admin/login`:

```javascript
const adminFetch = async (path, options = {}) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('admin_token')}`,
      ...options.headers,
    },
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json;              // keep the envelope — you need `pagination` too
};
```

`401` means the token is missing, malformed, or expired → send the user back to login.

---

## Date range parameters

Every analytics endpoint accepts the same window parameters.

| Param | Values | Default |
|---|---|---|
| `range` | `today` `yesterday` `7d` `30d` `90d` `12m` `mtd` `last_month` `ytd` `all` `custom` | `30d` |
| `start` | `2026-08-01` or a full ISO timestamp | — |
| `end` | `2026-08-31` or a full ISO timestamp (a bare date is **inclusive**) | — |
| `tz_offset_minutes` | Minutes east of UTC, e.g. `-420` for UTC−07:00 | `0` (UTC) |

Passing `start` or `end` forces `range=custom`.

**Always send `tz_offset_minutes`,** or "today" means 00:00 UTC and the merchant's
numbers will look wrong:

```javascript
const tzOffset = -new Date().getTimezoneOffset();   // e.g. -420 in Los Angeles
```

### The comparison window

Every response echoes a `range` object that includes `previous_start` /
`previous_end` — the window the `previous` and `changes` figures are measured
against. It is the equal-length window immediately before the selected one, so
"Today" at 2pm compares against yesterday up to 2pm, not all of yesterday.
`mtd` and `last_month` compare against the same span of the previous month.

```jsonc
"range": {
  "preset": "30d",
  "start": "2026-07-16T07:00:00.000Z",
  "end": "2026-08-14T18:00:00.000Z",
  "tz_offset_minutes": -420,
  "previous_start": "2026-06-16T20:00:00.000Z",
  "previous_end": "2026-07-16T07:00:00.000Z"
}
```

---

## `GET /admin/analytics/dashboard`

**Use this one for the overview page.** It returns everything below in a single
round trip — KPIs, chart, best sellers, recent orders, work queue, list growth.

| Extra param | Values | Default |
|---|---|---|
| `interval` | `hour` `day` `week` `month` | picked from the range length |
| `compare` | `true` to also return the previous period's chart points | `false` |
| `top_products_limit` | 1–50 | `5` |
| `recent_orders_limit` | 1–50 | `10` |
| `low_stock_threshold` | products at or below this stock level are flagged | `5` |

```
GET /admin/analytics/dashboard?range=30d&tz_offset_minutes=-420&compare=true
```

```jsonc
{
  "ok": true,
  "data": {
    "range": { "preset": "30d", "start": "…", "end": "…",
               "tz_offset_minutes": -420,
               "previous_start": "…", "previous_end": "…" },
    "currency": "usd",

    // ── KPI cards ──────────────────────────────────────────────────────────
    "metrics": {
      "total_sales":         15500,  // what customers actually paid (cents)
      "gross_sales":         16000,  // total_sales + discounts
      "discounts":             500,
      "orders":                  3,
      "units_sold":              4,
      "average_order_value":  5167,  // total_sales / orders, rounded
      "customers":               2,  // distinct emails that ordered in the window
      "new_customers":           2   // whose first-ever paid order is in the window
    },
    "previous": { /* same shape, for previous_start → previous_end */ },
    "changes": {
      // Percent change vs. `previous`, one decimal. null = no baseline
      // (previous was 0) → render an em dash, not "+100%".
      "total_sales": 55.0, "orders": 50.0, "average_order_value": 3.3,
      "gross_sales": 60.0, "discounts": null, "units_sold": 33.3,
      "customers": 100.0, "new_customers": 100.0
    },

    // ── Order counts WITHIN the selected range ─────────────────────────────
    "order_counts": {
      "pending": 1, "paid": 2, "fulfilled": 1, "cancelled": 1,
      "unfulfilled": 1, "processing": 0, "shipped": 1, "delivered": 1
    },

    // ── Sales chart ────────────────────────────────────────────────────────
    "chart": {
      "interval": "day",
      // Zero-filled: every bucket in the range is present, in order, so the
      // x-axis is continuous. Plot straight from this array.
      "points": [
        { "bucket": "2026-07-16", "total_sales": 0,    "orders": 0, "units_sold": 0 },
        { "bucket": "2026-07-17", "total_sales": 8000, "orders": 1, "units_sold": 1 }
      ],
      // Only when compare=true. Same length as `points` (aligned by index) —
      // overlay it as a dotted comparison line.
      "previous_points": [ /* … */ ]
    },

    // ── Best sellers ───────────────────────────────────────────────────────
    "top_products": [
      { "product_id": "uuid", "product_name": "Tee",
        "units_sold": 3, "total_revenue": 7500, "orders": 2 }
    ],

    // ── Recent orders table (trimmed — no notes/metadata/labels) ───────────
    "recent_orders": [
      { "id": "uuid", "created_at": "2026-08-14T…", "status": "paid",
        "fulfillment_status": "unfulfilled", "customer_name": "Shopper",
        "customer_email": "shopper@example.com",
        "amount_total": 5000, "currency": "usd", "item_count": 2 }
    ],

    // ── Work queue. These counts are ALL-TIME, not range-scoped, on purpose:
    //    switching the date filter to "Today" must not hide older unshipped
    //    orders. Don't render them inside the date-range card.
    "needs_attention": {
      "unfulfilled_orders": 1,   // paid but not shipped → "Orders to fulfill"
      "processing_orders": 0,
      "pending_orders": 1,       // checkouts that never completed payment
      "low_stock_products": [ { "id": "uuid", "name": "Tee", "stock": 2 } ]
    },

    // ── Newsletter growth ──────────────────────────────────────────────────
    "newsletter": { "total": 128, "subscribed": 120, "unsubscribed": 8, "new_last_30d": 34 }
  }
}
```

### Bucket key formats

`chart.points[].bucket` is a string keyed to the requested interval, already
shifted into `tz_offset_minutes`:

| interval | bucket | Example |
|---|---|---|
| `hour` | `YYYY-MM-DDTHH:00` | `2026-08-14T09:00` |
| `day` | `YYYY-MM-DD` | `2026-08-14` |
| `week` | `YYYY-MM-DD` — the **Monday** starting that week | `2026-08-10` |
| `month` | `YYYY-MM` | `2026-08` |

If a range would produce more than 800 points the interval is automatically
coarsened (`hour` → `day` → `week` → `month`). Read the interval actually used
from `chart.interval` in the response rather than assuming you got what you asked for.

---

## `GET /admin/analytics/overview`

Just the KPI cards — lighter than `/dashboard` if that's all you're re-fetching
(for example when the user flips the date filter on a page that already has its chart).

```
GET /admin/analytics/overview?range=today&tz_offset_minutes=-420
```

Returns `{ range, currency, metrics, previous, changes, order_counts }` — the same
shapes as in `/dashboard`.

---

## `GET /admin/analytics/timeseries`

The chart on its own, for a standalone reports page.

| Extra param | Values | Default |
|---|---|---|
| `interval` | `hour` `day` `week` `month` | from range length |
| `compare` | `true` → include `previous_points` | `false` |

```
GET /admin/analytics/timeseries?range=90d&interval=week&compare=true
```

```jsonc
{ "ok": true, "data": { "range": {…}, "interval": "week", "currency": "usd",
                        "points": [...], "previous_points": [...] } }
```

Points are zero-filled and sorted ascending — safe to feed directly to Recharts,
Chart.js, or a `<svg>` polyline.

---

## `GET /admin/analytics/top-products`

| Extra param | Values | Default |
|---|---|---|
| `limit` | 1–50 | `5` |
| `sort` | `units` or `revenue` | `units` |

```
GET /admin/analytics/top-products?range=30d&sort=revenue&limit=10
```

```jsonc
{ "ok": true, "data": { "range": {…}, "currency": "usd", "sort": "revenue",
  "products": [ { "product_id": "uuid", "product_name": "Hoodie",
                  "units_sold": 12, "total_revenue": 96000, "orders": 9 } ] } }
```

`total_revenue` is line-item revenue (unit price × quantity) **before** order-level
discounts, so the sum across products can exceed `metrics.total_sales`.
`product_name` is the name captured at purchase time — a product renamed or deleted
since still shows what the customer bought.

---

## `GET /admin/orders` (updated)

Same endpoint, now with pagination totals, search, date filtering, and sorting.
**`data` is still a bare array of full `Order` objects** — nothing existing breaks.

| Param | Values | Default |
|---|---|---|
| `limit` | 1–100 | `50` |
| `offset` | ≥ 0 | `0` |
| `status` | `pending` `paid` `fulfilled` `cancelled` | — |
| `fulfillment_status` | `unfulfilled` `processing` `shipped` `delivered` | — |
| `search` | substring of customer email/name, shipping name, order ID, tracking number | — |
| `sort` | `created_at` `amount_total` | `created_at` |
| `direction` | `desc` `asc` | `desc` |
| `range` / `start` / `end` / `tz_offset_minutes` | as above — date filtering is opt-in | none |

```
GET /admin/orders?status=paid&fulfillment_status=unfulfilled&limit=25&offset=0
GET /admin/orders?search=jane%40example.com
GET /admin/orders?range=mtd&tz_offset_minutes=-420&sort=amount_total&direction=desc
```

```jsonc
{
  "ok": true,
  "data": [ /* full Order objects, see ADMIN_API.md */ ],
  "pagination": { "total": 137, "limit": 25, "offset": 0, "has_more": true }
}
```

Page count is `Math.ceil(pagination.total / pagination.limit)`.

```javascript
// "Orders to fulfill" queue, page 1
const { data: orders, pagination } = await adminFetch(
  '/admin/orders?status=paid&fulfillment_status=unfulfilled&limit=25'
);
```

---

## Public newsletter endpoints

No auth. Call these straight from the storefront.

### `POST /newsletter/subscribe`

```jsonc
// Request
{
  "email": "fan@example.com",      // required
  "name": "Fan",                    // optional
  "source": "footer",               // optional — letters/digits/-/_ only, ≤50 chars.
                                    //   Use it to see which form converts:
                                    //   "footer" | "popup" | "checkout" | "landing-page"
  "tags": ["vip"],                  // optional — up to 10 strings
  "metadata": { "campaign": "spring" },  // optional
  "website": ""                     // HONEYPOT — see below. Always send it empty.
}
```

```jsonc
// 201 — newly added
{ "ok": true, "data": { "email": "fan@example.com", "status": "subscribed",
                        "already_subscribed": false, "resubscribed": false } }

// 200 — was already on the list (NOT an error)
{ "ok": true, "data": { "email": "fan@example.com", "status": "subscribed",
                        "already_subscribed": true, "resubscribed": false } }

// 200 — previously opted out, now back on
{ "ok": true, "data": { …, "already_subscribed": false, "resubscribed": true } }

// 422 — invalid email
{ "ok": false, "error": "Validation failed",
  "details": { "fieldErrors": { "email": ["Invalid email"] } } }

// 429 — rate limited (10 requests/minute per IP)
{ "ok": false, "error": "Too many requests. Please try again shortly." }
```

The endpoint is **idempotent** — signing up twice is a success, not an error. Branch
your success message on `already_subscribed` / `resubscribed`.

Email is normalised (trimmed + lowercased) server-side, so `Fan@Example.COM ` and
`fan@example.com` are the same subscriber.

#### The honeypot field

Render a `website` input that real users never see and bots happily fill in. If it
arrives non-empty the request returns a normal success response and **stores nothing**.

```html
<!-- Must be off-screen, NOT type="hidden" — bots skip type="hidden" -->
<div style="position:absolute;left:-9999px" aria-hidden="true">
  <label>Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
</div>
```

#### Complete form example

```javascript
async function subscribe(form) {
  const res = await fetch(`${BASE_URL}/newsletter/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: form.email.value,
      source: 'footer',
      website: form.website.value,   // honeypot
    }),
  });
  const json = await res.json();

  if (res.status === 429) return 'Too many attempts — try again in a minute.';
  if (!json.ok) return json.details?.fieldErrors?.email?.[0] ?? json.error;
  if (json.data.already_subscribed) return "You're already on the list!";
  if (json.data.resubscribed) return 'Welcome back — you\'re subscribed again.';
  return 'Thanks! Check your inbox.';
}
```

### `POST /newsletter/unsubscribe`

```jsonc
// Body: either form works
{ "email": "fan@example.com" }
{ "token": "a6d7da772ccb435eafb3b318192c526c" }   // from an email footer link

// 200 — always, even for an address that was never on the list
{ "ok": true, "data": { "status": "unsubscribed" } }
```

Rate limited to 20 requests/minute per IP. The response is deliberately identical
whether or not the address existed, so this endpoint can't be used to test which
emails you hold.

### `GET /newsletter/unsubscribe?token=…`

One-click unsubscribe for email footer links, where a POST isn't possible. Same
response. Point your unsubscribe landing page at it:

```
https://<your-worker>.workers.dev/newsletter/unsubscribe?token={{unsubscribe_token}}
```

---

## Admin newsletter endpoints

All require the admin JWT.

### `GET /admin/newsletter/subscribers`

| Param | Values | Default |
|---|---|---|
| `limit` | 1–200 | `50` |
| `offset` | ≥ 0 | `0` |
| `status` | `subscribed` `unsubscribed` | — |
| `source` | exact match, e.g. `footer` | — |
| `search` | substring of email or name | — |

```jsonc
{
  "ok": true,
  "data": [{
    "id": "uuid",
    "email": "fan@example.com",
    "name": "Fan",
    "status": "subscribed",
    "source": "footer",
    "tags": ["vip"],
    "metadata": {},
    "country": "US",                 // from the Cloudflare edge; null in local dev
    "unsubscribe_token": "a6d7da…",  // put this in email footer links
    "subscribed_at": "2026-08-14T02:04:12.900Z",
    "unsubscribed_at": null,
    "created_at": "2026-08-14T02:04:12.900Z",
    "updated_at": "2026-08-14T02:04:12.900Z"
  }],
  "pagination": { "total": 128, "limit": 50, "offset": 0, "has_more": true }
}
```

### `GET /admin/newsletter/stats`

```jsonc
{ "ok": true, "data": { "total": 128, "subscribed": 120,
                        "unsubscribed": 8, "new_last_30d": 34 } }
```

### `GET /admin/newsletter/export`

Returns **`text/csv`**, not the JSON envelope. Accepts the same filters as the list
endpoint; defaults to `status=subscribed`, which is what an email provider wants.
Capped at 10,000 rows — page with `offset` beyond that.

Columns: `email, name, status, source, tags, country, subscribed_at, unsubscribed_at, created_at`
(`tags` are pipe-separated).

Because it needs an `Authorization` header you can't just link to it — fetch and
save the blob:

```javascript
async function exportSubscribers() {
  const res = await fetch(`${BASE_URL}/admin/newsletter/export?status=subscribed`, {
    headers: { Authorization: `Bearer ${localStorage.getItem('admin_token')}` },
  });
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {
    href: url, download: 'subscribers.csv',
  });
  a.click();
  URL.revokeObjectURL(url);
}
```

### `PUT /admin/newsletter/subscribers/:id`

```jsonc
// Body — all fields optional
{ "name": "Fan", "status": "unsubscribed", "tags": ["vip"], "metadata": {} }
```

Returns the updated subscriber. Changing `status` stamps `unsubscribed_at`
automatically, and clears it on re-subscribe.

### `DELETE /admin/newsletter/subscribers/:id`

Hard delete → `{ "ok": true, "data": { "deleted": true } }`.

Use this for GDPR/CCPA erasure requests only. For a normal opt-out prefer
`PUT { "status": "unsubscribed" }` — deleting loses the record that they opted out,
so a later import could add them back.

---

## Display helpers

```javascript
// Money — API values are integer cents
const formatMoney = (cents, currency = 'usd') =>
  new Intl.NumberFormat('en-US', {
    style: 'currency', currency: currency.toUpperCase(),
  }).format(cents / 100);
// formatMoney(15500) → "$155.00"

// Percent delta — null means "no baseline to compare against"
const formatChange = (pct) =>
  pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;

const changeTone = (pct) =>
  pct === null ? 'neutral' : pct > 0 ? 'positive' : pct < 0 ? 'negative' : 'neutral';
// For the discounts card, invert the tone — rising discounts aren't good news.

// Chart x-axis labels
function formatBucket(bucket, interval) {
  if (interval === 'month') return new Date(`${bucket}-01T00:00:00`)
    .toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  if (interval === 'hour') return new Date(`${bucket}:00`)
    .toLocaleTimeString('en-US', { hour: 'numeric' });
  return new Date(`${bucket}T00:00:00`)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
// Bucket strings are already in the merchant's timezone — parse them as LOCAL
// time (no trailing "Z"), or every label shifts by a day.

const tzOffset = -new Date().getTimezoneOffset();   // send on every analytics call
```

---

## Suggested dashboard layout

One `GET /admin/analytics/dashboard` call fills this entire page.

```
┌──────────────────────────────────────────────────────────────────────┐
│  Range picker: Today ▾   (range + tz_offset_minutes → refetch)       │
├──────────────────────────────────────────────────────────────────────┤
│  Total sales   │  Orders   │  Avg order value  │  Units sold         │
│  $155.00       │  3        │  $51.67           │  4                  │
│  +55.0% ▲      │  +50.0% ▲ │  +3.3% ▲          │  +33.3% ▲           │
│  ← metrics.* with changes.* underneath                               │
├──────────────────────────────────────────────────────────────────────┤
│  Sales over time                            ← chart.points           │
│  (dotted overlay = chart.previous_points when compare=true)          │
├────────────────────────────────┬─────────────────────────────────────┤
│  Top products                  │  Needs attention                    │
│  ← top_products                │  ← needs_attention (ALL-TIME —      │
│                                │    don't label it with the range)   │
│                                │  • 1 order to fulfill               │
│                                │  • 1 abandoned checkout             │
│                                │  • 1 product low on stock           │
├────────────────────────────────┴─────────────────────────────────────┤
│  Recent orders   ← recent_orders (link each row to /orders/:id)      │
├──────────────────────────────────────────────────────────────────────┤
│  Newsletter: 120 subscribed · +34 in 30 days   ← newsletter          │
└──────────────────────────────────────────────────────────────────────┘
```

**Gotchas worth repeating:**

1. Send `tz_offset_minutes` on every analytics request.
2. `changes.*` can be `null` (no baseline) — render `—`, not `+100%`.
3. `needs_attention` is all-time by design; `order_counts` is range-scoped.
4. Chart points are pre-zero-filled — don't fill gaps again client-side.
5. Read `chart.interval` from the response; the server may coarsen what you asked for.
6. Pagination lives next to `data`, not inside it.

---

## Endpoints summary

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/admin/analytics/dashboard` | JWT | Whole overview page in one call |
| `GET` | `/admin/analytics/overview` | JWT | KPI cards + period-over-period deltas |
| `GET` | `/admin/analytics/timeseries` | JWT | Sales over time, zero-filled |
| `GET` | `/admin/analytics/top-products` | JWT | Best sellers by units or revenue |
| `GET` | `/admin/orders` | JWT | Orders — now paginated, searchable, sortable |
| `POST` | `/newsletter/subscribe` | — | Public signup → `201` / `200` if already on list |
| `POST` | `/newsletter/unsubscribe` | — | Public opt-out by email or token |
| `GET` | `/newsletter/unsubscribe?token=` | — | One-click opt-out for email footers |
| `GET` | `/admin/newsletter/subscribers` | JWT | Paginated subscriber list |
| `GET` | `/admin/newsletter/stats` | JWT | Totals + 30-day growth |
| `GET` | `/admin/newsletter/export` | JWT | CSV download (`text/csv`) |
| `PUT` | `/admin/newsletter/subscribers/:id` | JWT | Update name / status / tags |
| `DELETE` | `/admin/newsletter/subscribers/:id` | JWT | Hard delete (GDPR erasure) |
