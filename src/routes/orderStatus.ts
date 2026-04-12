import { Hono } from "hono";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

const orderStatus = new Hono<{ Bindings: Bindings }>();

/**
 * GET /orders?session_id=cs_test_...
 *
 * Public endpoint — lets a customer look up their order status after checkout.
 * The `session_id` acts as a capability token (unguessable Stripe session ID).
 *
 * Intended use: display order confirmation and tracking info on the success page.
 *
 * Returns only the fields safe for public display (no internal notes or metadata).
 */
orderStatus.get("/", async (c) => {
  const sessionId = c.req.query("session_id");

  if (!sessionId) {
    return c.json(err("Query param `session_id` is required"), 400);
  }

  try {
    const db = getDatabase(c.env);
    const order = await db.getOrderByStripeSession(sessionId);

    if (!order) {
      return c.json(err("Order not found"), 404);
    }

    // Return a public-safe subset of the order.
    const publicOrder = {
      id: order.id,
      status: order.status,
      fulfillment_status: order.fulfillment_status,
      customer_email: order.customer_email,
      customer_name: order.customer_name,
      shipping_name: order.shipping_name,
      shipping_address_line1: order.shipping_address_line1,
      shipping_address_line2: order.shipping_address_line2,
      shipping_city: order.shipping_city,
      shipping_state: order.shipping_state,
      shipping_postal_code: order.shipping_postal_code,
      shipping_country: order.shipping_country,
      shipping_carrier: order.shipping_carrier,
      shipping_service: order.shipping_service,
      tracking_number: order.tracking_number,
      amount_total: order.amount_total,
      currency: order.currency,
      items: order.items.map((item) => ({
        id: item.id,
        product_id: item.product_id,
        product_name: item.product_name,
        price: item.price,
        quantity: item.quantity,
        currency: item.currency,
      })),
      created_at: order.created_at,
      updated_at: order.updated_at,
    };

    return c.json(ok(publicOrder));
  } catch (e) {
    console.error("GET /orders error:", e);
    return c.json(err("Failed to fetch order"), 500);
  }
});

export { orderStatus };
