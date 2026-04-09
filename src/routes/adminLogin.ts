import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sign } from "hono/jwt";
import type { Bindings } from "../types.js";
import { ok, err } from "../types.js";

const TOKEN_TTL = 60 * 60 * 8; // 8 hours

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const adminLogin = new Hono<{ Bindings: Bindings }>();

adminLogin.post("/", zValidator("json", loginSchema), async (c) => {
  const { username, password } = c.req.valid("json");

  if (!c.env.ADMIN_USERNAME || !c.env.ADMIN_PASSWORD || !c.env.JWT_SECRET) {
    return c.json(err("Server misconfiguration: admin credentials not set"), 500);
  }

  const validUsername = timingSafeEqual(username, c.env.ADMIN_USERNAME);
  const validPassword = timingSafeEqual(password, c.env.ADMIN_PASSWORD);

  if (!validUsername || !validPassword) {
    return c.json(err("Invalid username or password"), 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await sign(
    { sub: "admin", iat: now, exp: now + TOKEN_TTL },
    c.env.JWT_SECRET,
    "HS256"
  );

  return c.json(ok({ token }));
});

function timingSafeEqual(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = 0;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0 && aBytes.length === bBytes.length;
}
