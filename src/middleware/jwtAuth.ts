import type { Context, Next } from "hono";
import { verify } from "hono/jwt";
import type { Bindings, JwtPayload } from "../types.js";
import { err } from "../types.js";

export function jwtAuthMiddleware() {
  return async (c: Context<{ Bindings: Bindings }>, next: Next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return c.json(err("Unauthorized: missing or malformed Authorization header"), 401);
    }

    const token = authHeader.slice(7);
    try {
      const payload = await verify(token, c.env.JWT_SECRET) as JwtPayload;
      c.set("jwtPayload", payload);
      await next();
    } catch {
      return c.json(err("Unauthorized: invalid or expired token"), 401);
    }
  };
}
