import { Hono } from "hono";
import { logger } from "hono/logger";
import { secureHeaders } from "hono/secure-headers";
import type { Bindings } from "./types.js";
import { corsMiddleware } from "./middleware/cors.js";
import { csrfMiddleware } from "./middleware/csrf.js";
import { adminAuthMiddleware } from "./middleware/auth.js";
import { products } from "./routes/products.js";
import { admin } from "./routes/admin.js";
import { auth } from "./routes/auth.js";
import { checkout } from "./routes/checkout.js";
import { webhooks } from "./routes/webhooks.js";

const app = new Hono<{ Bindings: Bindings }>();

// ─── Global Middleware ────────────────────────────────────────────────────────

app.use("*", logger());

// Security headers (X-Content-Type-Options, X-Frame-Options, etc.)
app.use("*", secureHeaders());

// CORS — must come before CSRF so that preflight requests are handled first.
app.use("*", corsMiddleware());

// CSRF origin check — configured via CSRF_ENABLED in wrangler.toml.
app.use("*", csrfMiddleware());

// ─── Health Check ─────────────────────────────────────────────────────────────

app.get("/", (c) =>
  c.json({
    ok: true,
    data: {
      service: "e-commaxxing",
      version: "1.0.0",
      db: c.env.DB_ADAPTER ?? "d1",
    },
  })
);

app.get("/health", (c) => c.json({ ok: true, data: { status: "healthy" } }));

// ─── Public Routes ────────────────────────────────────────────────────────────

// Admin authentication (login → JWT). No auth middleware on this route.
app.route("/auth", auth);

// Product catalog (read-only, publicly accessible)
app.route("/products", products);

// Stripe checkout (publicly accessible — customers initiate purchases)
app.route("/checkout", checkout);

// Stripe webhooks (verified by signature, no auth middleware needed)
app.route("/webhooks", webhooks);

// ─── Admin Routes (protected by API key) ─────────────────────────────────────

app.use("/admin/*", adminAuthMiddleware());
app.route("/admin", admin);

// ─── 404 Handler ─────────────────────────────────────────────────────────────

app.notFound((c) =>
  c.json({ ok: false, error: `Route not found: ${c.req.method} ${c.req.path}` }, 404)
);

// ─── Error Handler ────────────────────────────────────────────────────────────

app.onError((e, c) => {
  console.error("Unhandled error:", e);
  return c.json({ ok: false, error: "Internal server error" }, 500);
});

export default app;
