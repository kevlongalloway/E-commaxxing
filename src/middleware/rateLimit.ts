import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../types.js";

/**
 * Best-effort in-memory rate limiter for public write endpoints.
 *
 * IMPORTANT: state lives in the Worker isolate, and Cloudflare runs many
 * isolates across many colos. A determined attacker spread across regions gets
 * roughly `limit` requests per isolate, not per account. This is enough to stop
 * a naive script hammering the newsletter form from one machine; it is not a
 * substitute for a real limiter.
 *
 * To make it strict, put a Cloudflare Rate Limiting rule in front of the route,
 * or swap the counter store for a KV / Durable Object binding.
 */

type Counter = { count: number; resetAt: number };

const buckets = new Map<string, Counter>();

/** Drops expired counters so the map can't grow without bound. */
function prune(now: number): void {
  for (const [key, counter] of buckets) {
    if (counter.resetAt <= now) buckets.delete(key);
  }
}

export type RateLimitOptions = {
  /** Max requests allowed per window, per client. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
  /** Namespace, so two routes don't share one budget. */
  name: string;
};

export const rateLimit = (
  options: RateLimitOptions
): MiddlewareHandler<{ Bindings: Bindings }> => {
  return async (c, next) => {
    // CF-Connecting-IP is set by Cloudflare's edge and cannot be spoofed by the
    // client; the other headers are fallbacks for local `wrangler dev`.
    const ip =
      c.req.header("CF-Connecting-IP") ??
      c.req.header("X-Forwarded-For")?.split(",")[0]?.trim() ??
      "unknown";

    const key = `${options.name}:${ip}`;
    const now = Date.now();

    // Cheap opportunistic cleanup — roughly 1 in 50 requests.
    if (Math.random() < 0.02) prune(now);

    const existing = buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + options.windowMs });
      return next();
    }

    if (existing.count >= options.limit) {
      const retryAfter = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
      return c.json(
        { ok: false, error: "Too many requests. Please try again shortly." },
        429,
        { "Retry-After": String(retryAfter) }
      );
    }

    existing.count += 1;
    return next();
  };
};
