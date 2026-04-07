import { Hono } from "hono";
import Stripe from "stripe";
import type { Bindings } from "../types.js";
import { ok, err } from "../types.js";

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
    apiVersion: "2024-11-20.acacia",
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
        // TODO: fulfill the order — update your DB, send confirmation email, etc.
        // session.metadata contains { product_ids, quantities } set in /checkout/session
        break;
      }

      case "payment_intent.succeeded": {
        const intent = event.data.object as Stripe.PaymentIntent;
        console.log(`✅ Payment succeeded: ${intent.id} — ${intent.amount} ${intent.currency}`);
        // TODO: fulfill the order for custom checkout flows.
        // intent.metadata contains { product_ids, quantities } set in /checkout/intent
        break;
      }

      case "payment_intent.payment_failed": {
        const intent = event.data.object as Stripe.PaymentIntent;
        const reason = intent.last_payment_error?.message ?? "unknown reason";
        console.warn(`❌ Payment failed: ${intent.id} — ${reason}`);
        // TODO: notify the customer.
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

export { webhooks };
