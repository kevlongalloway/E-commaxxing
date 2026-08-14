-- Migration: 0006_create_settings
--
-- Creates a small key/value store for storefront configuration that isn't a
-- product, order, or discount — starting with the landing-page header video.
--
-- `value` holds a JSON document, so a new setting means a new key rather than
-- a new migration. Current keys:
--
--   header_video → { "desktop_url": string|null,
--                    "mobile_url":  string|null,   -- null = reuse the desktop video
--                    "poster_url":  string|null }  -- still frame shown while loading

CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '{}',   -- JSON document
  updated_at TEXT NOT NULL
);
