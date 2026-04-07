import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../types.js";
import { verifyJWT } from "../lib/jwt.js";

/**
 * Admin authentication middleware.
 *
 * Accepts two token types in the `Authorization: Bearer <token>` header:
 *
 *   1. Static API key  — set via `wrangler secret put ADMIN_API_KEY`.
 *      Used for server-to-server integrations or CI scripts.
 *
 *   2. JWT             — issued by `POST /auth/login`.
 *      Used by the admin frontend after a username/password login.
 *      Verified with `JWT_SECRET` (set via `wrangler secret put JWT_SECRET`).
 *
 * Apply this middleware only to admin routes (see src/index.ts).
 */
export const adminAuthMiddleware = (): MiddlewareHandler<{
  Bindings: Bindings;
}> => {
  return async (c, next) => {
    const adminKey = c.env.ADMIN_API_KEY;

    if (!adminKey) {
      return c.json(
        { ok: false, error: "Server misconfiguration: ADMIN_API_KEY not set" },
        500
      );
    }

    const authHeader = c.req.header("Authorization") ?? "";
    const [scheme, token] = authHeader.split(" ");

    if (scheme !== "Bearer" || !token) {
      return c.json(
        {
          ok: false,
          error: "Unauthorized: missing or malformed Authorization header",
        },
        401
      );
    }

    // 1. Check static API key (constant-time).
    if (timingSafeEqual(token, adminKey)) {
      return next();
    }

    // 2. Try to verify as a JWT (requires JWT_SECRET to be configured).
    const jwtSecret = c.env.JWT_SECRET;
    if (jwtSecret) {
      const payload = await verifyJWT(token, jwtSecret);
      if (payload !== null) {
        return next();
      }
    }

    return c.json({ ok: false, error: "Unauthorized: invalid token" }, 401);
  };
};

/** Simple constant-time string comparison to prevent timing attacks. */
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
