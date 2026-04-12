-- Migration: 0003_create_discounts
-- Creates the discounts table and adds discount tracking columns to orders.
--
-- Discount types:
--   percentage   → value = 1–100 (percent off qualifying items)
--   fixed_amount → value = amount in smallest currency unit (e.g. 500 = $5.00 off)
--   free_shipping → value ignored; recorded for fulfillment reference
--
-- Applies-to:
--   all      → discount applies to the entire order subtotal
--   products → discount applies only to items whose product_id is in product_ids
--
-- Automatic discounts (sales/promotions): code IS NULL — applied automatically at checkout
-- Code-required discounts: code IS NOT NULL — customer must enter the code

CREATE TABLE IF NOT EXISTS discounts (
  id                    TEXT    PRIMARY KEY,
  code                  TEXT    UNIQUE,           -- NULL = automatic; string = requires customer entry
  name                  TEXT    NOT NULL,         -- internal label, e.g. "Summer Sale 2024"
  description           TEXT    NOT NULL DEFAULT '',  -- customer-facing description
  type                  TEXT    NOT NULL,         -- "percentage" | "fixed_amount" | "free_shipping"
  value                 INTEGER NOT NULL DEFAULT 0,   -- percent (1-100) or fixed amount in smallest unit
  applies_to            TEXT    NOT NULL DEFAULT 'all',  -- "all" | "products"
  product_ids           TEXT    NOT NULL DEFAULT '[]',   -- JSON array of qualifying product UUIDs
  minimum_order_amount  INTEGER NOT NULL DEFAULT 0,   -- 0 = no minimum; otherwise smallest currency unit
  usage_limit           INTEGER,                  -- NULL = unlimited uses
  usage_count           INTEGER NOT NULL DEFAULT 0,
  active                INTEGER NOT NULL DEFAULT 1,   -- 0 = inactive, 1 = active
  starts_at             TEXT,                     -- ISO 8601; NULL = active immediately
  ends_at               TEXT,                     -- ISO 8601; NULL = never expires
  created_at            TEXT    NOT NULL,
  updated_at            TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_discounts_code      ON discounts (code);
CREATE INDEX IF NOT EXISTS idx_discounts_active    ON discounts (active);
CREATE INDEX IF NOT EXISTS idx_discounts_ends_at   ON discounts (ends_at);

-- Add discount tracking columns to the orders table.
ALTER TABLE orders ADD COLUMN discount_id     TEXT;
ALTER TABLE orders ADD COLUMN discount_code   TEXT;
ALTER TABLE orders ADD COLUMN discount_amount INTEGER NOT NULL DEFAULT 0;
