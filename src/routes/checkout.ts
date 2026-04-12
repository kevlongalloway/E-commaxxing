import { Hono } from "hono";
import Stripe from "stripe";
import type { Bindings, Discount } from "../types.js";
import { getDatabase, calculateDiscountAmount } from "../db/index.js";
import { ok, err } from "../types.js";

const checkout = new Hono<{ Bindings: Bindings }>();

function getStripe(secretKey: string): Stripe {
  return new Stripe(secretKey, {
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

function parseShippingCountries(
  raw: string | undefined
): Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] | undefined {
  if (!raw || raw.trim() === "*" || raw.trim() === "") return undefined;
  return raw
    .split(",")
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean) as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[];
}

/**
 * Validate a discount code/automatic discount against a cart.
 * Returns the discount and amount, or null if no discount applies.
 */
async function resolveDiscount(
  db: ReturnType<typeof getDatabase>,
  code: string | null | undefined,
  items: Array<{ product_id: string; price: number; quantity: number }>,
  subtotal: number
): Promise<{ discount: Discount; discount_amount: number } | null> {
  if (code) {
    const discount = await db.getDiscountByCode(code.trim().toUpperCase());
    if (!discount) return null;

    const amount = calculateDiscountAmount(discount, items, subtotal);
    if (amount === 0 && discount.type !== "free_shipping") return null;
    return { discount, discount_amount: amount };
  }

  // No code — check for automatic discounts (sales/promos).
  const automatics = await db.getActiveAutomaticDiscounts();
  let best: { discount: Discount; discount_amount: number } | null = null;
  for (const d of automatics) {
    const amount = calculateDiscountAmount(d, items, subtotal);
    if (amount > 0 && (!best || amount > best.discount_amount)) {
      best = { discount: d, discount_amount: amount };
    }
  }
  return best;
}

// ─── POST /checkout/session ───────────────────────────────────────────────────
/**
 * Creates a Stripe Checkout Session (hosted payment page).
 *
 * Stripe collects the customer's shipping address and phone automatically.
 * If a `discountCode` is provided, it is validated and applied to the session.
 * Automatic sales/promotions are applied automatically if no code is given.
 *
 * Body:
 * {
 *   items:        [{ productId: string, quantity: number }],
 *   successUrl:   string,
 *   cancelUrl:    string,
 *   discountCode?: string   // optional — omit to apply automatic discounts
 * }
 *
 * Response: { ok: true, data: { url, sessionId, discount_amount, final_amount } }
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

  const successUrl   = (body as { successUrl?: unknown }).successUrl;
  const cancelUrl    = (body as { cancelUrl?: unknown }).cancelUrl;
  const discountCode = (body as { discountCode?: unknown }).discountCode;

  if (typeof successUrl !== "string" || typeof cancelUrl !== "string") {
    return c.json(err("Body must include `successUrl` and `cancelUrl` strings"), 400);
  }

  try {
    const db     = getDatabase(c.env);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

    const products = await Promise.all(items.map((item) => db.getProduct(item.productId)));

    for (let i = 0; i < products.length; i++) {
      const p    = products[i];
      const item = items[i]!;
      if (!p)        return c.json(err(`Product not found: ${item.productId}`), 404);
      if (!p.active) return c.json(err(`Product is no longer available: ${p.name}`), 400);
      if (p.stock !== -1 && p.stock < item.quantity) {
        return c.json(err(`Insufficient stock for "${p.name}" (available: ${p.stock})`), 400);
      }
    }

    const subtotal = products.reduce((sum, p, i) => sum + p!.price * items[i]!.quantity, 0);
    const dbItems  = products.map((p, i) => ({
      product_id: p!.id,
      price:      p!.price,
      quantity:   items[i]!.quantity,
    }));

    // ── Resolve discount ───────────────────────────────────────────────────────
    const codeArg = typeof discountCode === "string" ? discountCode : null;
    const applied = await resolveDiscount(db, codeArg, dbItems, subtotal);

    if (codeArg && !applied) {
      return c.json(err(`Discount code "${codeArg}" is invalid or does not apply to this cart`), 400);
    }

    const discountAmount = applied?.discount_amount ?? 0;

    // ── Build Stripe line items ────────────────────────────────────────────────
    // Apply the discount proportionally across qualifying line items so that
    // Stripe's hosted page shows accurate per-item prices.
    const qualifyingSubtotal =
      applied && applied.discount.applies_to === "products"
        ? dbItems.reduce((sum, item) =>
            applied.discount.product_ids.includes(item.product_id)
              ? sum + item.price * item.quantity
              : sum, 0)
        : subtotal;

    const lineItems: Stripe.Checkout.SessionCreateParams.LineItem[] = products.map((p, i) => {
      let unitAmount = p!.price;

      if (applied && discountAmount > 0 && applied.discount.type !== "free_shipping") {
        const isQualifying =
          applied.discount.applies_to === "all" ||
          applied.discount.product_ids.includes(p!.id);

        if (isQualifying) {
          // Distribute the discount proportionally by this item's share of qualifying subtotal.
          const itemTotal      = p!.price * items[i]!.quantity;
          const itemShare      = qualifyingSubtotal > 0 ? itemTotal / qualifyingSubtotal : 0;
          const itemDiscount   = Math.round(discountAmount * itemShare);
          const discountedTotal = Math.max(0, itemTotal - itemDiscount);
          // Per-unit discounted price (rounded; Stripe requires integer unit amounts).
          unitAmount = Math.max(1, Math.round(discountedTotal / items[i]!.quantity));
        }
      }

      const nameSuffix =
        applied && applied.discount.type !== "free_shipping" &&
        (applied.discount.applies_to === "all" || applied.discount.product_ids.includes(p!.id))
          ? ` (${applied.discount.code ?? applied.discount.name})`
          : "";

      return {
        price_data: {
          currency: p!.currency,
          product_data: {
            name:        p!.name + nameSuffix,
            description: p!.description || undefined,
            images:      p!.images.slice(0, 8),
            metadata:    { product_id: p!.id },
          },
          unit_amount: unitAmount,
        },
        quantity: items[i]!.quantity,
      };
    });

    const allowedCountries = parseShippingCountries(c.env.SHIPPING_COUNTRIES);
    const shippingAddressCollection: Stripe.Checkout.SessionCreateParams.ShippingAddressCollection =
      allowedCountries
        ? { allowed_countries: allowedCountries }
        : { allowed_countries: ["US", "CA", "GB", "AU", "NZ"] as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[] };

    const session = await stripe.checkout.sessions.create({
      mode:      "payment",
      line_items: lineItems,
      success_url: successUrl,
      cancel_url:  cancelUrl,
      shipping_address_collection: shippingAddressCollection,
      phone_number_collection: { enabled: true },
      metadata: {
        product_ids:     items.map((i) => i.productId).join(","),
        quantities:      items.map((i) => i.quantity).join(","),
        discount_id:     applied?.discount.id ?? "",
        discount_code:   applied?.discount.code ?? "",
        discount_amount: String(discountAmount),
      },
    });

    return c.json(ok({
      url:             session.url,
      sessionId:       session.id,
      discount_amount: discountAmount,
      original_amount: subtotal,
      final_amount:    Math.max(0, subtotal - discountAmount),
      is_free_shipping: applied?.discount.type === "free_shipping",
    }));
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
 *
 * Body:
 * {
 *   items: [{ productId: string, quantity: number }],
 *   discountCode?:   string,
 *   shippingAddress?: { name?, line1, line2?, city, state?, postalCode, country, phone? }
 * }
 *
 * Response data:
 * {
 *   clientSecret, paymentIntentId, amount, currency, publishableKey,
 *   discount_amount, original_amount, final_amount, is_free_shipping
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

  const discountCode    = (body as { discountCode?: unknown }).discountCode;
  const shippingAddress = (body as { shippingAddress?: unknown }).shippingAddress as ShippingAddress | undefined;

  try {
    const db     = getDatabase(c.env);
    const stripe = getStripe(c.env.STRIPE_SECRET_KEY);

    const products = await Promise.all(items.map((item) => db.getProduct(item.productId)));

    for (let i = 0; i < products.length; i++) {
      const p    = products[i];
      const item = items[i]!;
      if (!p)        return c.json(err(`Product not found: ${item.productId}`), 404);
      if (!p.active) return c.json(err(`Product unavailable: ${p.name}`), 400);
      if (p.stock !== -1 && p.stock < item.quantity) {
        return c.json(err(`Insufficient stock for "${p.name}"`), 400);
      }
    }

    const currencies = [...new Set(products.map((p) => p!.currency))];
    if (currencies.length > 1) {
      return c.json(err("All items in an order must have the same currency"), 400);
    }

    const currency = currencies[0]!;
    const subtotal = products.reduce((sum, p, i) => sum + p!.price * items[i]!.quantity, 0);
    const dbItems  = products.map((p, i) => ({
      product_id: p!.id,
      price:      p!.price,
      quantity:   items[i]!.quantity,
    }));

    // ── Resolve discount ───────────────────────────────────────────────────────
    const codeArg = typeof discountCode === "string" ? discountCode : null;
    const applied = await resolveDiscount(db, codeArg, dbItems, subtotal);

    if (codeArg && !applied) {
      return c.json(err(`Discount code "${codeArg}" is invalid or does not apply to this cart`), 400);
    }

    const discountAmount = applied?.discount_amount ?? 0;
    const finalAmount    = Math.max(0, subtotal - discountAmount);

    const stripeShipping: Stripe.PaymentIntentCreateParams.Shipping | undefined =
      shippingAddress
        ? {
            name: shippingAddress.name ?? "Customer",
            address: {
              line1:       shippingAddress.line1,
              line2:       shippingAddress.line2 ?? undefined,
              city:        shippingAddress.city,
              state:       shippingAddress.state ?? undefined,
              postal_code: shippingAddress.postalCode,
              country:     shippingAddress.country,
            },
            phone: shippingAddress.phone ?? undefined,
          }
        : undefined;

    const intent = await stripe.paymentIntents.create({
      amount:   finalAmount,
      currency,
      automatic_payment_methods: { enabled: true },
      ...(stripeShipping && { shipping: stripeShipping }),
      metadata: {
        product_ids:     items.map((i) => i.productId).join(","),
        quantities:      items.map((i) => i.quantity).join(","),
        discount_id:     applied?.discount.id ?? "",
        discount_code:   applied?.discount.code ?? "",
        discount_amount: String(discountAmount),
      },
    });

    return c.json(ok({
      clientSecret:     intent.client_secret,
      paymentIntentId:  intent.id,
      amount:           finalAmount,
      currency,
      publishableKey:   c.env.STRIPE_PUBLISHABLE_KEY,
      discount_amount:  discountAmount,
      original_amount:  subtotal,
      final_amount:     finalAmount,
      is_free_shipping: applied?.discount.type === "free_shipping",
    }));
  } catch (e) {
    console.error("POST /checkout/intent error:", e);
    if (e instanceof Stripe.errors.StripeError) {
      return c.json(err(`Stripe error: ${e.message}`), 502);
    }
    return c.json(err("Failed to create payment intent"), 500);
  }
});

export { checkout };
