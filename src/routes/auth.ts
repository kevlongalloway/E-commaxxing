import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { sign } from "hono/jwt";
import type { Bindings, JwtPayload } from "../types.js";
import { ok, err } from "../types.js";
import { getDatabase } from "../db/index.js";
import { verifyPassword } from "../lib/password.js";
import { jwtAuthMiddleware } from "../middleware/jwtAuth.js";

const TOKEN_TTL = 60 * 60 * 24 * 7; // 7 days in seconds

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const auth = new Hono<{ Bindings: Bindings }>();

auth.post("/register", zValidator("json", registerSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const db = getDatabase(c.env);

  const existing = await db.getUserByEmail(email);
  if (existing) {
    return c.json(err("An account with that email already exists"), 409);
  }

  const user = await db.createUser({ email, password });

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
  };
  const token = await sign(payload, c.env.JWT_SECRET);

  return c.json(ok({ token, user }), 201);
});

auth.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");
  const db = getDatabase(c.env);

  const user = await db.getUserByEmail(email);
  if (!user) {
    return c.json(err("Invalid email or password"), 401);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) {
    return c.json(err("Invalid email or password"), 401);
  }

  const payload: JwtPayload = {
    sub: user.id,
    email: user.email,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL,
  };
  const token = await sign(payload, c.env.JWT_SECRET);

  const { password_hash: _, ...safeUser } = user;
  return c.json(ok({ token, user: safeUser }));
});

auth.get("/me", jwtAuthMiddleware(), async (c) => {
  const payload = c.get("jwtPayload") as JwtPayload;
  const db = getDatabase(c.env);

  const user = await db.getUserById(payload.sub);
  if (!user) {
    return c.json(err("User not found"), 404);
  }

  return c.json(ok({ user }));
});
