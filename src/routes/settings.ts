import { Hono } from "hono";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";
import { getStorefrontSettings } from "../lib/settings.js";

/**
 * Public storefront configuration — no auth. The landing page calls this to
 * find out which header video to play.
 */
const settings = new Hono<{ Bindings: Bindings }>();

/**
 * A media URL that is safe to drop into a `src` attribute.
 *
 * `z.string().url()` alone is not enough: it accepts any scheme, including
 * `javascript:`, which would become stored XSS the moment the storefront
 * renders it. Restrict to http/https.
 */
export const mediaUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .url()
  .refine(
    (value) => {
      try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use http or https" }
  );

// ─── GET /settings ────────────────────────────────────────────────────────────
/**
 * All public storefront settings in one call.
 *
 * Response:
 *   { ok: true, data: { header_video: { desktop_url, mobile_url, poster_url } } }
 *
 * Fields are null when unset. `mobile_url` being null means "no separate mobile
 * cut" — play `desktop_url` on mobile as well.
 */
settings.get("/", async (c) => {
  try {
    const db = getDatabase(c.env);
    const data = await getStorefrontSettings(db);

    // Hit on every landing-page load and changes rarely — let the edge and the
    // browser hold it briefly.
    c.header("Cache-Control", "public, max-age=60");
    return c.json(ok(data));
  } catch (e) {
    console.error("GET /settings error:", e);
    return c.json(err("Failed to fetch settings"), 500);
  }
});

export { settings };
