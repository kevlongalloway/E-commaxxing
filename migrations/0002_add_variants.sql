-- Migration: 0002_add_variants
-- Creates the product_variants table for size/color variants with per-variant stock tracking.

CREATE TABLE IF NOT EXISTS product_variants (
  id          TEXT    PRIMARY KEY,
  product_id  TEXT    NOT NULL,
  size        TEXT    NOT NULL,
  color       TEXT,
  sku         TEXT,
  stock       INTEGER NOT NULL DEFAULT -1,     -- -1 = unlimited stock
  metadata    TEXT    NOT NULL DEFAULT '{}',   -- JSON object for variant-specific fields
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,

  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  UNIQUE(product_id, size, color)
);

CREATE INDEX IF NOT EXISTS idx_variants_product_id ON product_variants (product_id);
CREATE INDEX IF NOT EXISTS idx_variants_size      ON product_variants (size);
CREATE INDEX IF NOT EXISTS idx_variants_sku       ON product_variants (sku);
