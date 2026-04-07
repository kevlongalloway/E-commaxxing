import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { ok, err } from "../types.js";
import { signJWT } from "../lib/jwt.js";

export const auth = new Hono<{ Bindings: Bindings }>();

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

/** Constant-time string comparison to prevent timing attacks. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  const maxLen = Math.max(a.length, b.length);
  for (let i = 0; i < maxLen; i++) {
    diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
  }
  return diff === 0 && a.length === b.length;
}

/**
 * POST /auth/login
 *
 * Authenticates an admin user and returns a short-lived JWT.
 *
 * Body:     { username: string, password: string }
 * Response: { ok: true, data: { token: string, expiresIn: number } }
 *
 * The returned `token` should be sent as `Authorization: Bearer <token>`
 * on all subsequent requests to `/admin/*` endpoints.
 *
 * Secrets required (set via `wrangler secret put`):
 *   ADMIN_USERNAME  — admin login username
 *   ADMIN_PASSWORD  — admin login password
 *   JWT_SECRET      — secret key used to sign tokens (min 32 chars recommended)
 */
auth.post(
  "/login",
  zValidator("json", loginSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const { username, password } = c.req.valid("json");
    const { ADMIN_USERNAME, ADMIN_PASSWORD, JWT_SECRET } = c.env;

    if (!ADMIN_USERNAME || !ADMIN_PASSWORD || !JWT_SECRET) {
      return c.json(
        err("Server misconfiguration: admin credentials not configured"),
        500
      );
    }

    const usernameOk = timingSafeEqual(username, ADMIN_USERNAME);
    const passwordOk = timingSafeEqual(password, ADMIN_PASSWORD);

    // Both checks run regardless of username result to prevent timing leaks.
    if (!usernameOk || !passwordOk) {
      return c.json(err("Invalid credentials"), 401);
    }

    const expiresIn = 8 * 60 * 60; // 8 hours
    const token = await signJWT({ sub: "admin" }, JWT_SECRET, expiresIn);

    return c.json(ok({ token, expiresIn }));
  }
);
