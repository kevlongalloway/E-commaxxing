import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../types.js";

/**
 * CSRF protection middleware (Origin-based).
 *
 * When enabled (`CSRF_ENABLED = "true"` in wrangler.toml), every state-changing
 * request (POST, PUT, PATCH, DELETE) must include an `Origin` header that
 * matches one of the values in `CORS_ORIGINS`.
 *
 * WHY: Browsers automatically attach cookies (and some auth headers) to
 * cross-origin requests.  Validating the Origin header prevents a malicious
 * website from tricking a logged-in user's browser into making unwanted API
 * calls.  Requests from server-side code, mobile apps, and curl do NOT send an
 * Origin header and are therefore unaffected.
 *
 * This is NOT a traditional double-submit-cookie approach — it's a simpler
 * same-origin check that's equally effective for JSON APIs.
 *
 * Configure in wrangler.toml:
 *   CSRF_ENABLED = "true"
 *   CORS_ORIGINS = "https://myshop.com"
 */
export const csrfMiddleware = (): MiddlewareHandler<{ Bindings: Bindings }> => {
  return async (c, next) => {
    const enabled = (c.env.CSRF_ENABLED ?? "false").toLowerCase() === "true";

    if (!enabled) {
      await next();
      return;
    }

    const METHOD_SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
    if (METHOD_SAFE.has(c.req.method)) {
      await next();
      return;
    }

    const requestOrigin = c.req.header("Origin");

    // Requests without an Origin header (server-to-server, curl, mobile) are
    // allowed through — they can't be CSRF attacks from a browser.
    if (!requestOrigin) {
      await next();
      return;
    }

    const allowedOrigins = (c.env.CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    if (allowedOrigins.includes("*") || allowedOrigins.includes(requestOrigin)) {
      await next();
      return;
    }

    return c.json(
      { ok: false, error: "Forbidden: CSRF origin check failed" },
      403
    );
  };
};
