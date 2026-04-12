import { Hono } from "hono";
import Stripe from "stripe";
import type { Bindings } from "../types.js";
import { ok, err } from "../types.js";
import { getDatabase } from "../db/index.js";

const webhooks = new Hono<{ Bindings: Bindings }>();

/**
 * POST /webhooks/stripe
 *
 * Receives and verifies Stripe webhook events.
 *
 * Setup:
 * 1. In your Stripe dashboard → Developers → Webhooks, add an endpoint:
 *    URL: https://<your-worker>.workers.dev/webhooks/stripe
 *    Events to listen for:
 *      - checkout.session.completed
 *      - payment_intent.succeeded
 *      - payment_intent.payment_failed
 *
 * 2. Copy the signing secret and run:
 *    wrangler secret put STRIPE_WEBHOOK_SECRET
 *
 * The raw body MUST be used for signature verification — Hono's c.req.raw
 * provides this without buffering through JSON parsing.
 */
webhooks.post("/stripe", async (c) => {
  if (!c.env.STRIPE_WEBHOOK_SECRET) {
    console.error("STRIPE_WEBHOOK_SECRET is not set — cannot verify webhook");
    return c.json(err("Webhook not configured"), 503);
  }

  const signature = c.req.header("stripe-signature");
  if (!signature) {
    return c.json(err("Missing stripe-signature header"), 400);
  }

  // Read the raw body as text (required for signature verification).
  const rawBody = await c.req.text();

  const stripe = new Stripe(c.env.STRIPE_SECRET_KEY, {
    httpClient: Stripe.createFetchHttpClient(),
    apiVersion: "2025-02-24.acacia",
  });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      rawBody,
      signature,
      c.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (e) {
    console.error("Webhook signature verification failed:", e);
    return c.json(err("Invalid webhook signature"), 400);
  }

  // Handle events.
  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        console.log(
          `✅ Checkout session completed: ${session.id} — ` +
            `amount: ${session.amount_total} ${session.currency}`
        );
        await handleCheckoutSessionCompleted(session, c.env);
        break;
      }

      case "payment_intent.succeeded": {
        const intent = event.data.object as Stripe.PaymentIntent;
        console.log(`✅ Payment succeeded: ${intent.id} — ${intent.amount} ${intent.currency}`);
        await handlePaymentIntentSucceeded(intent, c.env);
        break;
      }

      case "payment_intent.payment_failed": {
        const intent = event.data.object as Stripe.PaymentIntent;
        const reason = intent.last_payment_error?.message ?? "unknown reason";
        console.warn(`❌ Payment failed: ${intent.id} — ${reason}`);
        await handlePaymentIntentFailed(intent, c.env);
        break;
      }

      default:
        // Unhandled event types are fine — return 200 so Stripe doesn't retry.
        console.log(`Unhandled Stripe event type: ${event.type}`);
    }
  } catch (e) {
    console.error(`Error handling Stripe event ${event.type}:`, e);
    // Return 200 anyway to prevent Stripe from retrying indefinitely.
    // Log the error and investigate manually.
  }

  return c.json(ok({ received: true }));
});

// ─── Event handlers ───────────────────────────────────────────────────────────

/**
 * checkout.session.completed
 *
 * Creates a new order (status = "paid") with line items and shipping address
 * extracted from the Stripe session. If the session was created via
 * /checkout/intent, a matching order may already exist from
 * payment_intent.succeeded; in that case we update it with the session ID.
 */
async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
  env: Bindings
): Promise<void> {
  const db = getDatabase(env);

  // Avoid double-creating if already handled by payment_intent.succeeded.
  if (session.payment_intent) {
    const existing = await db.getOrderByStripeIntent(session.payment_intent as string);
    if (existing) {
      // Link the session ID and ensure status is paid.
      await db.updateOrder(existing.id, { status: "paid" });
      console.log(`Order ${existing.id} already exists; linked session ${session.id}`);
      return;
    }
  }

  // Also guard against duplicate delivery of this webhook.
  const duplicate = await db.getOrderByStripeSession(session.id);
  if (duplicate) {
    console.log(`Order for session ${session.id} already created — skipping`);
    return;
  }

  // Decode metadata set in /checkout/session.
  const productIds = session.metadata?.product_ids?.split(",").filter(Boolean) ?? [];
  const quantities = (session.metadata?.quantities?.split(",") ?? []).map(Number);

  // Build order items from the product catalog.
  const items: Array<{
    product_id: string;
    product_name: string;
    price: number;
    quantity: number;
    currency: string;
  }> = [];

  for (let i = 0; i < productIds.length; i++) {
    const productId = productIds[i]!;
    const quantity = quantities[i] ?? 1;
    const product = await db.getProduct(productId);
    if (product) {
      items.push({
        product_id: product.id,
        product_name: product.name,
        price: product.price,
        quantity,
        currency: product.currency,
      });

      // Decrement stock if tracked.
      if (product.stock !== -1) {
        await db.updateProduct(product.id, { stock: Math.max(0, product.stock - quantity) });
      }
    } else {
      // Product deleted since checkout — record what Stripe reported.
      items.push({
        product_id: productId,
        product_name: `(deleted product ${productId})`,
        price: 0,
        quantity,
        currency: session.currency ?? "usd",
      });
    }
  }

  // Extract shipping and customer details from the session.
  const shipping = session.shipping_details;
  const customer = session.customer_details;

  const order = await db.createOrder({
    stripe_session_id: session.id,
    stripe_payment_intent_id: session.payment_intent as string | null ?? null,
    status: "paid",
    customer_email: customer?.email ?? null,
    customer_name: customer?.name ?? null,
    shipping_name: shipping?.name ?? customer?.name ?? null,
    shipping_address_line1: shipping?.address?.line1 ?? null,
    shipping_address_line2: shipping?.address?.line2 ?? null,
    shipping_city: shipping?.address?.city ?? null,
    shipping_state: shipping?.address?.state ?? null,
    shipping_postal_code: shipping?.address?.postal_code ?? null,
    shipping_country: shipping?.address?.country ?? null,
    shipping_phone: customer?.phone ?? null,
    amount_total: session.amount_total ?? 0,
    currency: session.currency ?? "usd",
    items,
  });

  console.log(`Created order ${order.id} for session ${session.id} — status: paid`);
}

/**
 * payment_intent.succeeded
 *
 * Used when the custom checkout flow (/checkout/intent) is used.
 * Creates a new order or updates an existing one.
 */
async function handlePaymentIntentSucceeded(
  intent: Stripe.PaymentIntent,
  env: Bindings
): Promise<void> {
  const db = getDatabase(env);

  // Guard against duplicate delivery.
  const existing = await db.getOrderByStripeIntent(intent.id);
  if (existing) {
    if (existing.status !== "paid") {
      await db.updateOrder(existing.id, { status: "paid" });
    }
    console.log(`Order ${existing.id} already exists for intent ${intent.id} — marked paid`);
    return;
  }

  // Decode metadata set in /checkout/intent.
  const productIds = intent.metadata?.product_ids?.split(",").filter(Boolean) ?? [];
  const quantities = (intent.metadata?.quantities?.split(",") ?? []).map(Number);

  const items: Array<{
    product_id: string;
    product_name: string;
    price: number;
    quantity: number;
    currency: string;
  }> = [];

  for (let i = 0; i < productIds.length; i++) {
    const productId = productIds[i]!;
    const quantity = quantities[i] ?? 1;
    const product = await db.getProduct(productId);
    if (product) {
      items.push({
        product_id: product.id,
        product_name: product.name,
        price: product.price,
        quantity,
        currency: product.currency,
      });

      if (product.stock !== -1) {
        await db.updateProduct(product.id, { stock: Math.max(0, product.stock - quantity) });
      }
    } else {
      items.push({
        product_id: productId,
        product_name: `(deleted product ${productId})`,
        price: 0,
        quantity,
        currency: intent.currency ?? "usd",
      });
    }
  }

  // shipping_details may be set if the Payment Intent was created with shipping.
  const shipping = intent.shipping;

  const order = await db.createOrder({
    stripe_payment_intent_id: intent.id,
    status: "paid",
    shipping_name: shipping?.name ?? null,
    shipping_address_line1: shipping?.address?.line1 ?? null,
    shipping_address_line2: shipping?.address?.line2 ?? null,
    shipping_city: shipping?.address?.city ?? null,
    shipping_state: shipping?.address?.state ?? null,
    shipping_postal_code: shipping?.address?.postal_code ?? null,
    shipping_country: shipping?.address?.country ?? null,
    shipping_phone: shipping?.phone ?? null,
    amount_total: intent.amount,
    currency: intent.currency ?? "usd",
    items,
  });

  console.log(`Created order ${order.id} for intent ${intent.id} — status: paid`);
}

/**
 * payment_intent.payment_failed
 *
 * If an order was already created (unlikely for first-attempt failures, but
 * possible on retry), mark it cancelled.
 */
async function handlePaymentIntentFailed(
  intent: Stripe.PaymentIntent,
  env: Bindings
): Promise<void> {
  const db = getDatabase(env);
  const existing = await db.getOrderByStripeIntent(intent.id);
  if (existing && existing.status === "pending") {
    await db.updateOrder(existing.id, { status: "cancelled" });
    console.log(`Order ${existing.id} cancelled — payment failed for intent ${intent.id}`);
  }
}

export { webhooks };
