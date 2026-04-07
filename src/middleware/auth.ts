import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../types.js";

/**
 * Admin API key authentication middleware.
 *
 * Expects the request to include:
 *   Authorization: Bearer <ADMIN_API_KEY>
 *
 * Set the key via:
 *   wrangler secret put ADMIN_API_KEY
 *
 * Apply this middleware only to admin routes (see src/index.ts).
 */
export const adminAuthMiddleware = (): MiddlewareHandler<{
  Bindings: Bindings;
}> => {
  return async (c, next) => {
    const adminKey = c.env.ADMIN_API_KEY;

    if (!adminKey) {
      // Misconfiguration — fail closed.
      return c.json(
        { ok: false, error: "Server misconfiguration: ADMIN_API_KEY not set" },
        500
      );
    }

    const authHeader = c.req.header("Authorization") ?? "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return c.json(
        { ok: false, error: "Unauthorized: missing or malformed Authorization header" },
        401
      );
    }

    // Constant-time comparison to prevent timing attacks.
    if (!timingSafeEqual(token, adminKey)) {
      return c.json({ ok: false, error: "Unauthorized: invalid API key" }, 401);
    }

    await next();
  };
};

/** Simple constant-time string comparison (no external dependency needed). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still iterate to avoid early-exit timing leak.
    let diff = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
    }
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}
