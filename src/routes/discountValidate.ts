import { Hono } from "hono";
import type { Bindings } from "../types.js";
import { getDatabase, calculateDiscountAmount } from "../db/index.js";
import { ok, err } from "../types.js";

const discountValidate = new Hono<{ Bindings: Bindings }>();

/**
 * POST /discounts/validate
 *
 * Public endpoint — validates a discount code against a cart and returns the
 * discount amount. Use this to show the customer their savings before they
 * proceed to checkout.
 *
 * Also returns active automatic discounts (sales/promotions) that apply to
 * the cart without a code — useful for showing sale badges.
 *
 * Body:
 * {
 *   code?: string,   // discount code entered by the customer (omit to check automatic discounts only)
 *   items: [{ productId: string, price: number, quantity: number }]
 * }
 *
 * Response data:
 * {
 *   valid:           boolean,
 *   discount_amount: number,    // amount saved in smallest currency unit
 *   original_amount: number,
 *   final_amount:    number,
 *   discount: { id, code, name, description, type, value } | null,
 *   automatic_discounts: [...]  // active sales/promotions (no code required)
 * }
 */
discountValidate.post("/", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(err("Invalid JSON body"), 400);
  }

  const b = body as {
    code?: unknown;
    items?: unknown;
  };

  // Validate items
  if (!Array.isArray(b.items) || b.items.length === 0) {
    return c.json(err("Body must include `items` array with at least one item"), 400);
  }

  type CartItem = { productId: string; price: number; quantity: number };
  const rawItems = b.items as unknown[];
  const validItems: CartItem[] = [];

  for (const item of rawItems) {
    const i = item as Record<string, unknown>;
    if (
      typeof i.productId !== "string" ||
      typeof i.price !== "number" ||
      typeof i.quantity !== "number" ||
      i.quantity <= 0
    ) {
      return c.json(
        err("Each item must have { productId: string, price: number, quantity: number > 0 }"),
        400
      );
    }
    validItems.push({ productId: i.productId as string, price: i.price as number, quantity: i.quantity as number });
  }

  const subtotal = validItems.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const dbItems  = validItems.map((i) => ({ product_id: i.productId, price: i.price, quantity: i.quantity }));

  try {
    const db = getDatabase(c.env);

    // ── Automatic discounts (sales/promotions — no code required) ──────────────
    const automaticDiscounts = await db.getActiveAutomaticDiscounts();
    const applicableAutomatic = automaticDiscounts
      .map((d) => {
        const amount = calculateDiscountAmount(d, dbItems, subtotal);
        return { discount: d, discount_amount: amount };
      })
      .filter((r) => r.discount_amount > 0 || r.discount.type === "free_shipping");

    // ── Code-required discount ─────────────────────────────────────────────────
    if (b.code !== undefined && b.code !== null && b.code !== "") {
      if (typeof b.code !== "string") {
        return c.json(err("`code` must be a string"), 400);
      }

      const discount = await db.getDiscountByCode(b.code.trim());

      if (!discount) {
        return c.json(
          ok({
            valid: false,
            error: "Invalid discount code",
            discount: null,
            discount_amount: 0,
            original_amount: subtotal,
            final_amount: subtotal,
            automatic_discounts: applicableAutomatic.map(safeDiscountPublic),
          })
        );
      }

      const now = new Date().toISOString();

      if (!discount.active) {
        return c.json(ok({ valid: false, error: "This discount is no longer active", discount: null, discount_amount: 0, original_amount: subtotal, final_amount: subtotal, automatic_discounts: applicableAutomatic.map(safeDiscountPublic) }));
      }
      if (discount.starts_at && now < discount.starts_at) {
        return c.json(ok({ valid: false, error: "This discount is not yet active", discount: null, discount_amount: 0, original_amount: subtotal, final_amount: subtotal, automatic_discounts: applicableAutomatic.map(safeDiscountPublic) }));
      }
      if (discount.ends_at && now > discount.ends_at) {
        return c.json(ok({ valid: false, error: "This discount has expired", discount: null, discount_amount: 0, original_amount: subtotal, final_amount: subtotal, automatic_discounts: applicableAutomatic.map(safeDiscountPublic) }));
      }
      if (discount.usage_limit !== null && discount.usage_count >= discount.usage_limit) {
        return c.json(ok({ valid: false, error: "This discount code has reached its usage limit", discount: null, discount_amount: 0, original_amount: subtotal, final_amount: subtotal, automatic_discounts: applicableAutomatic.map(safeDiscountPublic) }));
      }
      if (discount.minimum_order_amount > 0 && subtotal < discount.minimum_order_amount) {
        return c.json(ok({
          valid: false,
          error: `Minimum order of ${discount.minimum_order_amount} required for this discount`,
          discount: safeDiscountPublic({ discount, discount_amount: 0 }),
          discount_amount: 0,
          original_amount: subtotal,
          final_amount: subtotal,
          automatic_discounts: applicableAutomatic.map(safeDiscountPublic),
        }));
      }

      const discountAmount = calculateDiscountAmount(discount, dbItems, subtotal);

      if (discountAmount === 0 && discount.type !== "free_shipping") {
        return c.json(ok({
          valid: false,
          error: "This discount does not apply to the items in your cart",
          discount: safeDiscountPublic({ discount, discount_amount: 0 }),
          discount_amount: 0,
          original_amount: subtotal,
          final_amount: subtotal,
          automatic_discounts: applicableAutomatic.map(safeDiscountPublic),
        }));
      }

      return c.json(ok({
        valid: true,
        discount: safeDiscountPublic({ discount, discount_amount: discountAmount }),
        discount_amount: discountAmount,
        original_amount: subtotal,
        final_amount: Math.max(0, subtotal - discountAmount),
        is_free_shipping: discount.type === "free_shipping",
        automatic_discounts: applicableAutomatic.map(safeDiscountPublic),
      }));
    }

    // ── No code provided — return automatic discounts only ────────────────────
    const bestAutomatic = applicableAutomatic.sort((a, b) => b.discount_amount - a.discount_amount)[0];
    const totalAutoDiscount = bestAutomatic?.discount_amount ?? 0;

    return c.json(ok({
      valid: applicableAutomatic.length > 0,
      discount: bestAutomatic ? safeDiscountPublic(bestAutomatic) : null,
      discount_amount: totalAutoDiscount,
      original_amount: subtotal,
      final_amount: Math.max(0, subtotal - totalAutoDiscount),
      automatic_discounts: applicableAutomatic.map(safeDiscountPublic),
    }));
  } catch (e) {
    console.error("POST /discounts/validate error:", e);
    return c.json(err("Failed to validate discount"), 500);
  }
});

// Return only the public-safe fields of a discount.
function safeDiscountPublic(entry: { discount: { id: string; code: string | null; name: string; description: string; type: string; value: number; ends_at: string | null; minimum_order_amount: number }; discount_amount: number }) {
  return {
    id:                    entry.discount.id,
    code:                  entry.discount.code,
    name:                  entry.discount.name,
    description:           entry.discount.description,
    type:                  entry.discount.type,
    value:                 entry.discount.value,
    ends_at:               entry.discount.ends_at,
    minimum_order_amount:  entry.discount.minimum_order_amount,
    discount_amount:       entry.discount_amount,
  };
}

export { discountValidate };
