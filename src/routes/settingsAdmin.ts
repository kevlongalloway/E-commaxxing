import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings, HeaderVideo } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";
import { getHeaderVideo, saveHeaderVideo, getStorefrontSettings } from "../lib/settings.js";
import { mediaUrlSchema } from "./settings.js";

/**
 * Storefront settings management. Mounted under /admin/settings, so every route
 * here is behind the JWT middleware in index.ts.
 */
const settingsAdmin = new Hono<{ Bindings: Bindings }>();

/**
 * Partial update semantics, matching the rest of the admin API:
 *   omitted → leave as-is
 *   null    → clear the field
 *   string  → set it
 */
const headerVideoSchema = z
  .object({
    desktop_url: mediaUrlSchema.nullable().optional(),
    mobile_url: mediaUrlSchema.nullable().optional(),
    poster_url: mediaUrlSchema.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one of desktop_url, mobile_url, poster_url",
  });

// ─── GET /admin/settings ──────────────────────────────────────────────────────
/** Every storefront setting, same shape as the public GET /settings. */
settingsAdmin.get("/", async (c) => {
  try {
    const db = getDatabase(c.env);
    return c.json(ok(await getStorefrontSettings(db)));
  } catch (e) {
    console.error("GET /admin/settings error:", e);
    return c.json(err("Failed to fetch settings"), 500);
  }
});

// ─── GET /admin/settings/header-video ─────────────────────────────────────────
/** Just the header video, for the settings form. */
settingsAdmin.get("/header-video", async (c) => {
  try {
    const db = getDatabase(c.env);
    return c.json(ok(await getHeaderVideo(db)));
  } catch (e) {
    console.error("GET /admin/settings/header-video error:", e);
    return c.json(err("Failed to fetch header video"), 500);
  }
});

// ─── PUT /admin/settings/header-video ─────────────────────────────────────────
/**
 * Sets the landing-page header video.
 *
 * Body — every field optional; omit to leave unchanged, send null to clear:
 *   { "desktop_url": "https://cdn.example.com/hero-desktop.mp4",
 *     "mobile_url":  "https://cdn.example.com/hero-mobile.mp4",
 *     "poster_url":  "https://cdn.example.com/hero-poster.jpg" }
 *
 * When the same video is used everywhere, set `desktop_url` and leave
 * `mobile_url` null — the storefront falls back to the desktop URL.
 *
 * Response: { ok: true, data: { desktop_url, mobile_url, poster_url } }
 */
settingsAdmin.put(
  "/header-video",
  zValidator("json", headerVideoSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const input = c.req.valid("json");

    try {
      const db = getDatabase(c.env);
      const current = await getHeaderVideo(db);

      const updated: HeaderVideo = {
        desktop_url:
          input.desktop_url !== undefined ? input.desktop_url : current.desktop_url,
        mobile_url:
          input.mobile_url !== undefined ? input.mobile_url : current.mobile_url,
        poster_url:
          input.poster_url !== undefined ? input.poster_url : current.poster_url,
      };

      await saveHeaderVideo(db, updated);
      return c.json(ok(updated));
    } catch (e) {
      console.error("PUT /admin/settings/header-video error:", e);
      return c.json(err("Failed to update header video"), 500);
    }
  }
);

// ─── DELETE /admin/settings/header-video ──────────────────────────────────────
/** Clears all three URLs, so the storefront falls back to its static header. */
settingsAdmin.delete("/header-video", async (c) => {
  try {
    const db = getDatabase(c.env);
    const cleared: HeaderVideo = {
      desktop_url: null,
      mobile_url: null,
      poster_url: null,
    };
    await saveHeaderVideo(db, cleared);
    return c.json(ok(cleared));
  } catch (e) {
    console.error("DELETE /admin/settings/header-video error:", e);
    return c.json(err("Failed to clear header video"), 500);
  }
});

export { settingsAdmin };
