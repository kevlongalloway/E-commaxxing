-- Migration: 0001_create_products
-- Creates the products table for the e-commerce backend.

CREATE TABLE IF NOT EXISTS products (
  id          TEXT    PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL DEFAULT '',
  price       INTEGER NOT NULL,          -- stored in smallest currency unit (cents, pence, etc.)
  currency    TEXT    NOT NULL DEFAULT 'usd',
  images      TEXT    NOT NULL DEFAULT '[]',   -- JSON array of image URLs
  metadata    TEXT    NOT NULL DEFAULT '{}',   -- JSON object for arbitrary extra fields
  stock       INTEGER NOT NULL DEFAULT -1,     -- -1 = unlimited stock
  active      INTEGER NOT NULL DEFAULT 1,      -- 1 = visible, 0 = hidden
  stripe_product_id TEXT,
  stripe_price_id   TEXT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_products_active     ON products (active);
CREATE INDEX IF NOT EXISTS idx_products_created_at ON products (created_at DESC);
