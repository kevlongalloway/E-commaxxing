-- Migration: 0005_create_newsletter_and_analytics_indexes
--
-- 1. Creates the newsletter_subscribers table used by the public
--    POST /newsletter/subscribe endpoint and the admin subscriber list.
-- 2. Adds composite indexes that make the dashboard analytics queries
--    (sales in a date range, grouped by status) index-friendly.
--
-- Subscriber status lifecycle:
--   subscribed   → opted in, safe to email
--   unsubscribed → opted out, keep the row so re-subscribes are auditable
--                  and so you never re-add someone who opted out

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id                 TEXT    PRIMARY KEY,
  -- Always stored lowercased + trimmed so uniqueness is case-insensitive.
  email              TEXT    NOT NULL UNIQUE,
  name               TEXT,
  status             TEXT    NOT NULL DEFAULT 'subscribed',  -- subscribed | unsubscribed
  -- Where the signup came from, e.g. "footer", "popup", "checkout".
  source             TEXT    NOT NULL DEFAULT 'website',
  tags               TEXT    NOT NULL DEFAULT '[]',   -- JSON array of strings
  metadata           TEXT    NOT NULL DEFAULT '{}',   -- JSON object for arbitrary extra fields
  -- Two-letter country from the Cloudflare `cf.country` property, when available.
  country            TEXT,
  -- Unguessable token for one-click unsubscribe links in email footers.
  unsubscribe_token  TEXT    NOT NULL UNIQUE,
  subscribed_at      TEXT    NOT NULL,
  unsubscribed_at    TEXT,
  created_at         TEXT    NOT NULL,
  updated_at         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_newsletter_status     ON newsletter_subscribers (status);
CREATE INDEX IF NOT EXISTS idx_newsletter_created_at ON newsletter_subscribers (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_newsletter_source     ON newsletter_subscribers (source);

-- ─── Analytics indexes ────────────────────────────────────────────────────────
-- The dashboard filters orders by status within a created_at window, so a
-- composite index on (status, created_at) avoids a full table scan.

CREATE INDEX IF NOT EXISTS idx_orders_status_created
  ON orders (status, created_at);

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_created
  ON orders (fulfillment_status, created_at);

-- Top-products aggregation groups order_items by product_id.
CREATE INDEX IF NOT EXISTS idx_order_items_product
  ON order_items (product_id);

-- Customer-level metrics (new vs. returning) group orders by email.
CREATE INDEX IF NOT EXISTS idx_orders_customer_email
  ON orders (customer_email);
