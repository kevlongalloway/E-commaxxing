import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";
import { rateLimit } from "../middleware/rateLimit.js";

/**
 * Public newsletter signup — no authentication, called straight from the
 * storefront footer / popup / checkout.
 */
const newsletter = new Hono<{ Bindings: Bindings }>();

// ─── Validation schemas ───────────────────────────────────────────────────────

const subscribeSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(320),
  name: z.string().trim().max(255).nullable().optional(),
  /** Where the signup came from, so you can see which form converts. */
  source: z
    .string()
    .trim()
    .max(50)
    // Keep it a clean identifier — this ends up in admin filters and CSV exports.
    .regex(/^[a-z0-9_-]+$/i, "source may only contain letters, numbers, - and _")
    .optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(10).optional(),
  metadata: z.record(z.unknown()).optional(),
  /**
   * Honeypot. Real users never see this field, so anything filled in is a bot.
   * Render it hidden (CSS off-screen, not `type="hidden"`) and leave it empty.
   */
  website: z.string().max(255).optional(),
});

const unsubscribeSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(320).optional(),
    token: z.string().trim().min(8).max(100).optional(),
  })
  .refine((v) => Boolean(v.email || v.token), {
    message: "Either `email` or `token` is required",
  });

// ─── POST /newsletter/subscribe ───────────────────────────────────────────────
/**
 * Adds an email to the list. Idempotent — submitting the same address twice is
 * a success, not an error, so the storefront form never shows a scary message.
 *
 * Someone who previously unsubscribed and signs up again is re-subscribed
 * (their original row is reused, so the opt-out history stays auditable).
 *
 * Body: { email, name?, source?, tags?, metadata?, website? }
 * Response 201/200: { ok: true, data: { email, status, already_subscribed, resubscribed } }
 *
 * NOTE: `already_subscribed` tells a caller whether an address is on the list.
 * That's what makes the storefront UX good ("You're already signed up"), but it
 * is technically an enumeration signal. If your list membership is sensitive,
 * drop the flag from the response and always return the same body.
 */
newsletter.post(
  "/subscribe",
  rateLimit({ name: "newsletter-subscribe", limit: 10, windowMs: 60_000 }),
  zValidator("json", subscribeSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const input = c.req.valid("json");

    // Honeypot tripped — respond exactly like a success so the bot moves on.
    if (input.website && input.website.trim().length > 0) {
      return c.json(
        ok({
          email: input.email,
          status: "subscribed",
          already_subscribed: false,
          resubscribed: false,
        })
      );
    }

    try {
      const db = getDatabase(c.env);
      const existing = await db.getSubscriberByEmail(input.email);

      if (existing) {
        if (existing.status === "subscribed") {
          return c.json(
            ok({
              email: existing.email,
              status: existing.status,
              already_subscribed: true,
              resubscribed: false,
            })
          );
        }

        // Previously opted out — bring them back.
        const revived = await db.updateSubscriber(existing.id, {
          status: "subscribed",
          ...(input.name !== undefined ? { name: input.name } : {}),
        });

        return c.json(
          ok({
            email: revived?.email ?? existing.email,
            status: "subscribed",
            already_subscribed: false,
            resubscribed: true,
          })
        );
      }

      // `cf.country` is attached by the Cloudflare edge; absent in local dev.
      const country =
        (c.req.raw as { cf?: { country?: string } }).cf?.country ?? null;

      const created = await db.createSubscriber({
        email: input.email,
        name: input.name ?? null,
        source: input.source ?? "website",
        tags: input.tags ?? [],
        metadata: input.metadata ?? {},
        country,
      });

      return c.json(
        ok({
          email: created.email,
          status: created.status,
          already_subscribed: false,
          resubscribed: false,
        }),
        201
      );
    } catch (e) {
      console.error("POST /newsletter/subscribe error:", e);
      return c.json(err("Failed to subscribe"), 500);
    }
  }
);

// ─── POST /newsletter/unsubscribe ─────────────────────────────────────────────
/**
 * Opts an address out. Accepts either the raw email or the unsubscribe token
 * from an email footer link.
 *
 * Always reports success, even for an address that was never on the list —
 * otherwise this endpoint becomes a way to test which emails you hold.
 *
 * Body: { email } or { token }
 * Response: { ok: true, data: { status: "unsubscribed" } }
 */
newsletter.post(
  "/unsubscribe",
  rateLimit({ name: "newsletter-unsubscribe", limit: 20, windowMs: 60_000 }),
  zValidator("json", unsubscribeSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const { email, token } = c.req.valid("json");

    try {
      const db = getDatabase(c.env);
      const subscriber = token
        ? await db.getSubscriberByToken(token)
        : await db.getSubscriberByEmail(email!);

      if (subscriber && subscriber.status !== "unsubscribed") {
        await db.updateSubscriber(subscriber.id, { status: "unsubscribed" });
      }

      return c.json(ok({ status: "unsubscribed" }));
    } catch (e) {
      console.error("POST /newsletter/unsubscribe error:", e);
      return c.json(err("Failed to unsubscribe"), 500);
    }
  }
);

// ─── GET /newsletter/unsubscribe?token=... ────────────────────────────────────
/**
 * One-click unsubscribe for links in email footers, where a POST isn't
 * possible. Same uniform response as the POST variant.
 */
newsletter.get("/unsubscribe", async (c) => {
  const token = c.req.query("token");

  if (!token) {
    return c.json(err("Query param `token` is required"), 400);
  }

  try {
    const db = getDatabase(c.env);
    const subscriber = await db.getSubscriberByToken(token);

    if (subscriber && subscriber.status !== "unsubscribed") {
      await db.updateSubscriber(subscriber.id, { status: "unsubscribed" });
    }

    return c.json(ok({ status: "unsubscribed" }));
  } catch (e) {
    console.error("GET /newsletter/unsubscribe error:", e);
    return c.json(err("Failed to unsubscribe"), 500);
  }
});

export { newsletter };
