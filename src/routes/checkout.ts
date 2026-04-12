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
    apiVersion: "2025-02-24.acacia",
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type LineItem = { productId: string; quantity: number };

type ShippingAddress = {
  name?: string;
  line1: string;
  line2?: string;
  city: string;
  state?: string;
  postalCode: string;
  country: string;
  phone?: string;
};

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
      (i as { quantity: number }).quantity > 0
  )
    ? (items as LineItem[])
    : null;
}

/**
 * Parses `SHIPPING_COUNTRIES` env var into a list of Stripe-compatible country codes.
 * Returns `undefined` when unconfigured (Stripe defaults to all countries).
 */
function parseShippingCountries(
  raw: string | undefined
): Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] | undefined {
  if (!raw || raw.trim() === "*" || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean) as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[];
}

// ─── POST /checkout/session ───────────────────────────────────────────────────
/**
 * Creates a Stripe Checkout Session (hosted payment page).
 * The frontend redirects the user to the returned `url`.
 *
 * Stripe will collect the customer's shipping address during checkout.
 * The address is stored on the order when the webhook fires.
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

    // Verify all products exist and are active.
    for (let i = 0; i < products.length; i++) {
      const p = products[i];
      const item = items[i];
      if (!p) {
        return c.json(err(`Product not found: ${item!.productId}`), 404);
      }
      if (!p.active) {
        return c.json(err(`Product is no longer available: ${p.name}`), 400);
      }
      if (p.stock !== -1 && p.stock < item!.quantity) {
        return c.json(
          err(`Insufficient stock for "${p.name}" (available: ${p.stock})`),
          400
        );
      }
    }

    // Build Stripe line items using inline price_data (no pre-sync required).
    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = products.map(
      (p, i) => ({
        price_data: {
          currency: p!.currency,
          product_data: {
            name: p!.name,
            description: p!.description || undefined,
            images: p!.images.slice(0, 8), // Stripe max 8 images
            metadata: { product_id: p!.id },
          },
          unit_amount: p!.price,
        },
        quantity: items[i]!.quantity,
      })
    );

    // Build shipping address collection config.
    const allowedCountries = parseShippingCountries(c.env.SHIPPING_COUNTRIES);
    const shippingAddressCollection: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection =
      allowedCountries
        ? { allowed_countries: allowedCountries }
        : { allowed_countries: ["US", "CA", "GB", "AU", "NZ"] as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] };

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: lineItems,
      success_url: successUrl,
      cancel_url: cancelUrl,
      // Collect shipping address from the customer during checkout.
      shipping_address_collection: shippingAddressCollection,
      // Collect phone number for shipping contact.
      phone_number_collection: { enabled: true },
      metadata: {
        product_ids: items.map((i) => i.productId).join(","),
        quantities: items.map((i) => i.quantity).join(","),
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
 * When using a custom checkout UI, the frontend should collect the shipping
 * address and pass it in the `shippingAddress` field. This is stored on the
 * Stripe Payment Intent and picked up by the webhook handler.
 *
 * Body:
 * {
 *   items: [{ productId: string, quantity: number }],
 *   shippingAddress?: {
 *     name?:       string,
 *     line1:       string,
 *     line2?:      string,
 *     city:        string,
 *     state?:      string,
 *     postalCode:  string,
 *     country:     string,   // ISO 3166-1 alpha-2, e.g. "US"
 *     phone?:      string
 *   }
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

  // Optional shipping address from the custom checkout form.
  const shippingAddress = (body as { shippingAddress?: unknown }).shippingAddress as
    | ShippingAddress
    | undefined;

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
      if (p.stock !== -1 && p.stock < item!.quantity) {
        return c.json(err(`Insufficient stock for "${p.name}"`), 400);
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

    // Build the Stripe shipping param if an address was provided.
    const stripeShipping: Stripe.PaymentIntentCreateParams.Shipping | undefined =
      shippingAddress
        ? {
            name: shippingAddress.name ?? "Customer",
            address: {
              line1: shippingAddress.line1,
              line2: shippingAddress.line2 ?? undefined,
              city: shippingAddress.city,
              state: shippingAddress.state ?? undefined,
              postal_code: shippingAddress.postalCode,
              country: shippingAddress.country,
            },
            phone: shippingAddress.phone ?? undefined,
          }
        : undefined;

    const intent = await stripe.paymentIntents.create({
      amount: totalAmount,
      currency,
      automatic_payment_methods: { enabled: true },
      ...(stripeShipping && { shipping: stripeShipping }),
      metadata: {
        product_ids: items.map((i) => i.productId).join(","),
        quantities: items.map((i) => i.quantity).join(","),
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
