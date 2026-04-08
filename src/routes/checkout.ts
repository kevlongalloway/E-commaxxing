import { Hono } from "hono";
import Stripe from "stripe";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

const checkout = new Hono<{ Bindings: Bindings }>();

function getStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
    // Required: Cloudflare Workers use the Fetch API, not Node.js http.
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: "2024-11-20.acacia",
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type LineItem = { productId: string; quantity: number; size?: string; color?: string };

function parseLineItems(body: unknown): LineItem[] | null {
  if (!body || typeof body !== "object" || !Array.isArray((body as { items?: unknown }).items)) {
    return null;
  }
  const items = (body as { items: unknown[] }).items;
  return items.every(
    (i) =>
      typeof i === "object" &&
      i !== null &&
      typeof (i as { productId: unknown }).productId === "string" &&
      typeof (i as { quantity: unknown }).quantity === "number" &&
      (i as { quantity: number }).quantity > 0 &&
      ((i as { size?: unknown }).size === undefined || typeof (i as { size?: unknown }).size === "string") &&
      ((i as { color?: unknown }).color === undefined || typeof (i as { color?: unknown }).color === "string")
  )
    ? (items as LineItem[])
    : null;
}

// ─── POST /checkout/session ───────────────────────────────────────────────────
/**
 * Creates a Stripe Checkout Session (hosted payment page).
 * The frontend redirects the user to the returned `url`.
 *
 * Body:
 * {
 *   items: [{ productId: string, quantity: number }],
 *   successUrl: string,  // e.g. "https://myshop.com/success?session_id={CHECKOUT_SESSION_ID}"
 *   cancelUrl:  string   // e.g. "https://myshop.com/cart"
 * }
 *
 * Response: { ok: true, data: { url: string, sessionId: string } }
 */
checkout.post("/session", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(err("Stripe is not configured on this server"), 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Invalid JSON body"), 400);
  }

  const items = parseLineItems(body);
  if (!items || items.length === 0) {
    return c.json(
      err("Body must include `items` array with at least one { productId, quantity }"),
      400
    );
  }

  const successUrl = (body as { successUrl?: unknown }).successUrl;
  const cancelUrl = (body as { cancelUrl?: unknown }).cancelUrl;

  if (typeof successUrl !== "string" || typeof cancelUrl !== "string") {
    return c.json(err("Body must include `successUrl` and `cancelUrl` strings"), 400);
  }

  try {
    const db = getDatabase(c.env);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

    // Look up all products concurrently.
    const products = await Promise.all(
      items.map((item) => db.getProduct(item.productId))
    );

    // Verify all products exist and are active, and check stock (per variant if size provided).
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const item = items[i];
      if (!p) {
        return c.json(err(`Product not found: ${item!.productId}`), 404);
      }
      if (!p.active) {
        return c.json(err(`Product is no longer available: ${p.name}`), 400);
      }

      // If size is specified, check variant stock. Otherwise check product stock.
      if (item!.size) {
        const variants = await db.getProductVariants(p.id);
        const variant = variants.find(
          (v) => v.size === item!.size && (!item!.color || v.color === item!.color)
        );
        if (!variant) {
          return c.json(
            err(`"${p.name}" - ${item!.size}${item!.color ? ` (${item!.color})` : ""} not found`),
            404
          );
        }
        if (variant.stock !== -1 && variant.stock < item!.quantity) {
          return c.json(
            err(
              `Insufficient stock for "${p.name}" - ${item!.size}${item!.color ? ` (${item!.color})` : ""} (available: ${variant.stock})`
            ),
            400
          );
        }
      } else {
        if (p.stock !== -1 && p.stock < item!.quantity) {
          return c.json(
            err(`Insufficient stock for "${p.name}" (available: ${p.stock})`),
            400
          );
        }
      }
    }

    // Build Stripe line items using inline price_data (no pre-sync required).
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = products.map(
      (p, i) => {
        const item = items[i]!;
        const productName = item.size
          ? `${p!.name} - ${item.size}${item.color ? ` (${item.color})` : ""}`
          : p!.name;

        return {
          price_data: {
            currency: p!.currency,
            product_data: {
              name: productName,
              description: p!.description || undefined,
              images: p!.images.slice(0, 8), // Stripe max 8 images
              metadata: {
                product_id: p!.id,
                ...(item.size && { size: item.size }),
                ...(item.color && { color: item.color }),
              },
            },
            unit_amount: p!.price,
          },
          quantity: item.quantity,
        };
      }
    );

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        product_ids: items.map((i) => i.productId).join(","),
        quantities: items.map((i) => i.quantity).join(","),
        sizes: items.map((i) => i.size || "").join(","),
        colors: items.map((i) => i.color || "").join(","),
      },
    });

    return c.json(ok({ url: session.url, sessionId: session.id }));
  } catch (e) {
    console.error("POST /checkout/session error:", e);
    if (e instanceof Stripe.errors.StripeError) {
      return c.json(err(`Stripe error: ${e.message}`), 502);
    }
    return c.json(err("Failed to create checkout session"), 500);
  }
});

// ─── POST /checkout/intent ────────────────────────────────────────────────────
/**
 * Creates a Stripe Payment Intent (custom checkout UI).
 * Use this when you want to build your own payment form with Stripe Elements.
 *
 * Body:
 * {
 *   items: [{ productId: string, quantity: number }]
 * }
 *
 * Response: {
 *   ok: true,
 *   data: {
 *     clientSecret: string,
 *     paymentIntentId: string,
 *     amount: number,
 *     currency: string,
 *     publishableKey: string
 *   }
 * }
 */
checkout.post("/intent", async (c) => {
  if (!c.env.STRIPE_SECRET_KEY) {
    return c.json(err("Stripe is not configured on this server"), 503);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Invalid JSON body"), 400);
  }

  const items = parseLineItems(body);
  if (!items || items.length === 0) {
    return c.json(
      err("Body must include `items` array with at least one { productId, quantity }"),
      400
    );
  }

  try {
    const db = getDatabase(c.env);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

    const products = await Promise.all(
      items.map((item) => db.getProduct(item.productId))
    );

    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const item = items[i];
      if (!p) return c.json(err(`Product not found: ${item!.productId}`), 404);
      if (!p.active) return c.json(err(`Product unavailable: ${p.name}`), 400);

      // If size is specified, check variant stock. Otherwise check product stock.
      if (item!.size) {
        const variants = await db.getProductVariants(p.id);
        const variant = variants.find(
          (v) => v.size === item!.size && (!item!.color || v.color === item!.color)
        );
        if (!variant) {
          return c.json(
            err(`"${p.name}" - ${item!.size}${item!.color ? ` (${item!.color})` : ""} not found`),
            404
          );
        }
        if (variant.stock !== -1 && variant.stock < item!.quantity) {
          return c.json(err(`Insufficient stock for "${p.name}" - ${item!.size}`), 400);
        }
      } else {
        if (p.stock !== -1 && p.stock < item!.quantity) {
          return c.json(err(`Insufficient stock for "${p.name}"`), 400);
        }
      }
    }

    // All items must share the same currency.
    const currencies = [...new Set(products.map((p) => p!.currency))];
    if (currencies.length > 1) {
      return c.json(
        err("All items in an order must have the same currency"),
        400
      );
    }

    const currency = currencies[0]!;
    const totalAmount = products.reduce(
      (sum, p, i) => sum + p!.price * items[i]!.quantity,
      0
    );

    const intent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency,
      automatic_payment_methods: { enabled: true },
      metadata: {
        product_ids: items.map((i) => i.productId).join(","),
        quantities: items.map((i) => i.quantity).join(","),
        sizes: items.map((i) => i.size || "").join(","),
        colors: items.map((i) => i.color || "").join(","),
      },
    });

    return c.json(
      ok({
        clientSecret: intent.client_secret,
        paymentIntentId: intent.id,
        amount: totalAmount,
        currency,
        publishableKey: c.env.STRIPE_PUBLISHABLE_KEY,
      })
    );
  } catch (e) {
    console.error("POST /checkout/intent error:", e);
    if (e instanceof Stripe.errors.StripeError) {
      return c.json(err(`Stripe error: ${e.message}`), 502);
    }
    return c.json(err("Failed to create payment intent"), 500);
  }
});

export { checkout };
