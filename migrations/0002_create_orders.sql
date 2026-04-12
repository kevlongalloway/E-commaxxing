-- Migration: 0002_create_orders
-- Creates the orders and order_items tables for payment tracking and fulfillment.
--
-- Order status lifecycle:
--   pending  → payment initiated but not yet confirmed
--   paid     → Stripe confirmed payment (set by webhook)
--   fulfilled → all items shipped
--   cancelled → payment failed or order voided
--
-- Fulfillment status lifecycle:
--   unfulfilled → order paid, nothing shipped yet
--   processing  → label generated / preparing shipment
--   shipped     → tracking number assigned, in transit
--   delivered   → carrier confirmed delivery

CREATE TABLE IF NOT EXISTS orders (
  id                       TEXT    PRIMARY KEY,
  stripe_session_id        TEXT    UNIQUE,          -- cs_xxx  (checkout.session.completed)
  stripe_payment_intent_id TEXT    UNIQUE,          -- pi_xxx  (payment_intent.succeeded)
  status                   TEXT    NOT NULL DEFAULT 'pending',      -- pending | paid | fulfilled | cancelled
  fulfillment_status       TEXT    NOT NULL DEFAULT 'unfulfilled',  -- unfulfilled | processing | shipped | delivered
  customer_email           TEXT,
  customer_name            TEXT,
  shipping_name            TEXT,
  shipping_address_line1   TEXT,
  shipping_address_line2   TEXT,
  shipping_city            TEXT,
  shipping_state           TEXT,
  shipping_postal_code     TEXT,
  shipping_country         TEXT,
  shipping_phone           TEXT,
  shipping_carrier         TEXT,   -- e.g. "USPS", "UPS", "FedEx"
  shipping_service         TEXT,   -- e.g. "Priority", "Ground"
  tracking_number          TEXT,
  label_url                TEXT,   -- pre-signed or public URL to printable shipping label PDF
  amount_total             INTEGER NOT NULL DEFAULT 0,  -- in smallest currency unit
  currency                 TEXT    NOT NULL DEFAULT 'usd',
  metadata                 TEXT    NOT NULL DEFAULT '{}',
  notes                    TEXT    NOT NULL DEFAULT '',
  created_at               TEXT    NOT NULL,
  updated_at               TEXT    NOT NULL
);

-- Order line items — one row per product per order.
CREATE TABLE IF NOT EXISTS order_items (
  id           TEXT    PRIMARY KEY,
  order_id     TEXT    NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   TEXT    NOT NULL,
  product_name TEXT    NOT NULL,
  price        INTEGER NOT NULL,   -- unit price in smallest currency unit at time of purchase
  quantity     INTEGER NOT NULL,
  currency     TEXT    NOT NULL DEFAULT 'usd'
);

CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment    ON orders (fulfillment_status);
CREATE INDEX IF NOT EXISTS idx_orders_created_at     ON orders (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_session ON orders (stripe_session_id);
CREATE INDEX IF NOT EXISTS idx_orders_stripe_intent  ON orders (stripe_payment_intent_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order     ON order_items (order_id);
