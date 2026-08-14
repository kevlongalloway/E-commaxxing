import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings, SubscriberStatus } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

/**
 * Admin-side newsletter management. Mounted under /admin/newsletter, so every
 * route here is behind the JWT middleware in index.ts.
 */
const newsletterAdmin = new Hono<{ Bindings: Bindings }>();

const updateSubscriberSchema = z.object({
  name: z.string().trim().max(255).nullable().optional(),
  status: z.enum(["subscribed", "unsubscribed"]).optional(),
  tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  metadata: z.record(z.unknown()).optional(),
});

/** Shared list filters for the table, the count, and the CSV export. */
function readFilters(c: {
  req: { query: (key: string) => string | undefined };
}): { status?: SubscriberStatus; source?: string; search?: string } {
  const statusRaw = c.req.query("status");
  const status =
    statusRaw === "subscribed" || statusRaw === "unsubscribed" ? statusRaw : undefined;

  return {
    status,
    source: c.req.query("source") || undefined,
    search: c.req.query("search")?.trim() || undefined,
  };
}

// ─── GET /admin/newsletter/subscribers ────────────────────────────────────────
/**
 * Paginated subscriber list, newest first.
 *
 * Query params:
 *   limit   1–200, default 50
 *   offset  default 0
 *   status  "subscribed" | "unsubscribed"
 *   source  exact match, e.g. "footer"
 *   search  substring match on email or name
 *
 * Response: { ok: true, data: Subscriber[], pagination: { total, limit, offset, has_more } }
 */
newsletterAdmin.get("/subscribers", async (c) => {
  const limitRaw = parseInt(c.req.query("limit") ?? "50", 10);
  const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
  const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 200);
  const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);
  const filters = readFilters(c);

  try {
    const db = getDatabase(c.env);
    const [subscribers, total] = await Promise.all([
      db.getSubscribers({ ...filters, limit, offset }),
      db.countSubscribers(filters),
    ]);

    return c.json({
      ...ok(subscribers),
      pagination: { total, limit, offset, has_more: offset + subscribers.length < total },
    });
  } catch (e) {
    console.error("GET /admin/newsletter/subscribers error:", e);
    return c.json(err("Failed to fetch subscribers"), 500);
  }
});

// ─── GET /admin/newsletter/stats ──────────────────────────────────────────────
/**
 * Headline list numbers: total, subscribed, unsubscribed, signups in the last
 * 30 days. Also embedded in /admin/analytics/dashboard.
 */
newsletterAdmin.get("/stats", async (c) => {
  try {
    const db = getDatabase(c.env);
    return c.json(ok(await db.getSubscriberStats()));
  } catch (e) {
    console.error("GET /admin/newsletter/stats error:", e);
    return c.json(err("Failed to fetch newsletter stats"), 500);
  }
});

// ─── GET /admin/newsletter/export ─────────────────────────────────────────────
/**
 * CSV export for Mailchimp / Klaviyo / Resend imports. Accepts the same
 * filters as the list endpoint; defaults to subscribed-only, which is what you
 * want when uploading to an email provider.
 *
 * Returns text/csv (not the usual JSON envelope) as an attachment.
 * Capped at 10,000 rows per export — page with `offset` beyond that.
 */
newsletterAdmin.get("/export", async (c) => {
  const filters = readFilters(c);
  const offsetRaw = parseInt(c.req.query("offset") ?? "0", 10);
  const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);

  try {
    const db = getDatabase(c.env);
    const subscribers = await db.getSubscribers({
      ...filters,
      status: filters.status ?? "subscribed",
      limit: 10_000,
      offset,
    });

    const header = [
      "email",
      "name",
      "status",
      "source",
      "tags",
      "country",
      "subscribed_at",
      "unsubscribed_at",
      "created_at",
    ];

    const rows = subscribers.map((s) =>
      [
        s.email,
        s.name ?? "",
        s.status,
        s.source,
        s.tags.join("|"),
        s.country ?? "",
        s.subscribed_at,
        s.unsubscribed_at ?? "",
        s.created_at,
      ]
        .map(csvCell)
        .join(",")
    );

    const csv = [header.join(","), ...rows].join("\r\n");
    const filename = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    console.error("GET /admin/newsletter/export error:", e);
    return c.json(err("Failed to export subscribers"), 500);
  }
});

// ─── PUT /admin/newsletter/subscribers/:id ────────────────────────────────────
/**
 * Updates a subscriber — usually to opt someone out by hand, or to tag them.
 *
 * Body: { name?, status?, tags?, metadata? }
 */
newsletterAdmin.put(
  "/subscribers/:id",
  zValidator("json", updateSubscriberSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    const id = c.req.param("id");
    const input = c.req.valid("json");

    try {
      const db = getDatabase(c.env);
      const updated = await db.updateSubscriber(id, input);
      if (!updated) return c.json(err("Subscriber not found"), 404);
      return c.json(ok(updated));
    } catch (e) {
      console.error(`PUT /admin/newsletter/subscribers/${id} error:`, e);
      return c.json(err("Failed to update subscriber"), 500);
    }
  }
);

// ─── DELETE /admin/newsletter/subscribers/:id ─────────────────────────────────
/**
 * Permanently deletes a subscriber row — use for GDPR/CCPA erasure requests.
 *
 * For a normal opt-out prefer PUT with { "status": "unsubscribed" }: deleting
 * loses the record that they opted out, so a later signup import could add
 * them back.
 */
newsletterAdmin.delete("/subscribers/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const db = getDatabase(c.env);
    const deleted = await db.deleteSubscriber(id);
    if (!deleted) return c.json(err("Subscriber not found"), 404);
    return c.json(ok({ deleted: true }));
  } catch (e) {
    console.error(`DELETE /admin/newsletter/subscribers/${id} error:`, e);
    return c.json(err("Failed to delete subscriber"), 500);
  }
});

/**
 * Quotes a CSV cell. Doubles embedded quotes, and prefixes cells starting with
 * a formula character so spreadsheets don't execute them on open.
 */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export { newsletterAdmin };
