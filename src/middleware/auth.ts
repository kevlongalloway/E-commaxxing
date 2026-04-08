import type { MiddlewareHandler } from "hono";
import { verify } from "hono/jwt";
import type { Bindings } from "../types.js";

/**
 * Admin JWT authentication middleware.
 *
 * Expects: Authorization: Bearer <token>
 *
 * Token is obtained by calling POST /admin/login with ADMIN_USERNAME + ADMIN_PASSWORD.
 * Token is signed with JWT_SECRET (set via `wrangler secret put JWT_SECRET`).
 */
export const adminAuthMiddleware = (): MiddlewareHandler<{
  Bindings: Bindings;
}> => {
  return async (c, next) => {
    if (!c.env.JWT_SECRET) {
      return c.json(
        { ok: false, error: "Server misconfiguration: JWT_SECRET not set" },
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

    try {
      await verify(token, c.env.JWT_SECRET);
      await next();
    } catch {
      return c.json({ ok: false, error: "Unauthorized: invalid or expired token" }, 401);
    }
  };
};
