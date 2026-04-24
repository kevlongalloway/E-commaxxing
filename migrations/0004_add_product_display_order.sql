-- Migration: 0004_add_product_display_order
-- Adds display_order column to products table to support custom product ordering.

ALTER TABLE products ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0;

-- Initialize display_order based on creation order (ascending by created_at)
-- This assigns order 0 to the oldest product, 1 to the next, etc.
UPDATE products SET display_order = (
  SELECT COUNT(*) - 1
  FROM products p2
  WHERE p2.created_at <= products.created_at
  AND (p2.created_at < products.created_at OR p2.id <= products.id)
);

CREATE INDEX IF NOT EXISTS idx_products_display_order ON products (display_order ASC);
