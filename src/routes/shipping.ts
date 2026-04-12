import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import type { Bindings } from "../types.js";
import { getDatabase } from "../db/index.js";
import { ok, err } from "../types.js";

const shipping = new Hono<{ Bindings: Bindings }>();

// ─── EasyPost helpers ─────────────────────────────────────────────────────────

const EASYPOST_BASE = "https://api.easypost.com/v2";

type EasyPostAddress = {
  name?: string;
  street1: string;
  street2?: string;
  city: string;
  state?: string;
  zip: string;
  country: string;
  phone?: string;
  company?: string;
};

type EasyPostParcel = {
  length?: number;   // inches
  width?: number;    // inches
  height?: number;   // inches
  weight: number;    // ounces
};

type EasyPostRate = {
  id: string;
  carrier: string;
  service: string;
  rate: string;       // e.g. "5.73"
  currency: string;
  delivery_days: number | null;
};

type EasyPostShipment = {
  id: string;
  rates: EasyPostRate[];
  selected_rate: EasyPostRate | null;
  postage_label?: { label_url: string };
  tracking_code?: string;
};

async function easypostRequest<T>(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown
): Promise<T> {
  const credentials = btoa(`${apiKey}:`);
  const res = await fetch(`${EASYPOST_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Basic ${credentials}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as { error?: { message?: string } } & T;

  if (!res.ok) {
    const msg = json.error?.message ?? `EasyPost error ${res.status}`;
    throw new Error(msg);
  }

  return json as T;
}

// ─── Validation schemas ───────────────────────────────────────────────────────

const generateLabelSchema = z.object({
  // Parcel dimensions (inches and ounces).
  parcel: z.object({
    weight: z.number().positive(),
    length: z.number().positive().optional(),
    width: z.number().positive().optional(),
    height: z.number().positive().optional(),
  }),
  // Optional carrier/service preference.
  // If omitted, the cheapest available rate is selected automatically.
  carrier: z.string().optional(),
  service: z.string().optional(),
});

// ─── POST /admin/orders/:id/shipping-label ────────────────────────────────────
/**
 * Generate a shipping label for an order via EasyPost.
 *
 * Requires EASYPOST_API_KEY to be set (wrangler secret put EASYPOST_API_KEY)
 * and the store's from-address configured in wrangler.toml [vars].
 *
 * The order must have a shipping address (line1, city, postal_code, country).
 *
 * Body:
 * {
 *   parcel: {
 *     weight:  number,   // ounces (required)
 *     length?: number,   // inches (optional for weight-only rates)
 *     width?:  number,
 *     height?: number
 *   },
 *   carrier?: string,   // e.g. "USPS" — omit to auto-select cheapest
 *   service?: string    // e.g. "Priority" — must pair with carrier
 * }
 *
 * On success, the order is updated with:
 *   - tracking_number
 *   - label_url        (printable PDF URL)
 *   - shipping_carrier
 *   - shipping_service
 *   - fulfillment_status → "processing"
 *
 * Response data:
 * {
 *   tracking_number: string,
 *   label_url:       string,
 *   carrier:         string,
 *   service:         string,
 *   rate:            string,   // cost in USD
 *   rates:           EasyPostRate[]  // all available rates
 * }
 */
shipping.post(
  "/:id/shipping-label",
  zValidator("json", generateLabelSchema, (result, c) => {
    if (!result.success) {
      return c.json(err("Validation failed", result.error.flatten()), 422);
    }
  }),
  async (c) => {
    if (!c.env.EASYPOST_API_KEY) {
      return c.json(
        err(
          "Shipping label generation is not configured. " +
            "Set EASYPOST_API_KEY via: wrangler secret put EASYPOST_API_KEY"
        ),
        503
      );
    }

    const id = c.req.param("id");
    const { parcel, carrier, service } = c.req.valid("json");

    const db = getDatabase(c.env);
    const order = await db.getOrder(id);

    if (!order) {
      return c.json(err("Order not found"), 404);
    }

    if (!order.shipping_address_line1 || !order.shipping_city || !order.shipping_postal_code || !order.shipping_country) {
      return c.json(
        err(
          "Order is missing required shipping address fields " +
            "(shipping_address_line1, shipping_city, shipping_postal_code, shipping_country). " +
            "Update the order with a complete address before generating a label."
        ),
        400
      );
    }

    // Validate store from-address.
    if (!c.env.STORE_ADDRESS_LINE1 || !c.env.STORE_CITY || !c.env.STORE_POSTAL_CODE || !c.env.STORE_COUNTRY) {
      return c.json(
        err(
          "Store from-address is not configured. " +
            "Set STORE_ADDRESS_LINE1, STORE_CITY, STORE_POSTAL_CODE, STORE_COUNTRY in wrangler.toml [vars]."
        ),
        503
      );
    }

    const fromAddress: EasyPostAddress = {
      name: c.env.STORE_NAME || "Store",
      street1: c.env.STORE_ADDRESS_LINE1,
      street2: c.env.STORE_ADDRESS_LINE2 || undefined,
      city: c.env.STORE_CITY,
      state: c.env.STORE_STATE || undefined,
      zip: c.env.STORE_POSTAL_CODE,
      country: c.env.STORE_COUNTRY,
      phone: c.env.STORE_PHONE || undefined,
    };

    const toAddress: EasyPostAddress = {
      name: order.shipping_name ?? order.customer_name ?? "Customer",
      street1: order.shipping_address_line1,
      street2: order.shipping_address_line2 ?? undefined,
      city: order.shipping_city,
      state: order.shipping_state ?? undefined,
      zip: order.shipping_postal_code,
      country: order.shipping_country,
      phone: order.shipping_phone ?? undefined,
    };

    const easypostParcel: EasyPostParcel = {
      weight: parcel.weight,
      length: parcel.length,
      width: parcel.width,
      height: parcel.height,
    };

    try {
      // Create shipment — EasyPost returns all available rates.
      const shipment = await easypostRequest<EasyPostShipment>(
        c.env.EASYPOST_API_KEY,
        "POST",
        "/shipments",
        {
          shipment: {
            to_address: toAddress,
            from_address: fromAddress,
            parcel: easypostParcel,
          },
        }
      );

      if (!shipment.rates || shipment.rates.length === 0) {
        return c.json(err("No shipping rates available for this shipment"), 400);
      }

      // Select rate: prefer the specified carrier/service, otherwise pick cheapest.
      let selectedRate: EasyPostRate | undefined;

      if (carrier && service) {
        selectedRate = shipment.rates.find(
          (r) =>
            r.carrier.toLowerCase() === carrier.toLowerCase() &&
            r.service.toLowerCase() === service.toLowerCase()
        );
        if (!selectedRate) {
          return c.json(
            err(
              `No rate found for carrier "${carrier}" / service "${service}". ` +
                `Available rates: ${shipment.rates.map((r) => `${r.carrier}/${r.service}`).join(", ")}`
            ),
            400
          );
        }
      } else if (carrier) {
        // Match carrier only, pick cheapest service for that carrier.
        const carrierRates = shipment.rates.filter(
          (r) => r.carrier.toLowerCase() === carrier.toLowerCase()
        );
        selectedRate = carrierRates.sort(
          (a, b) => parseFloat(a.rate) - parseFloat(b.rate)
        )[0];
        if (!selectedRate) {
          return c.json(err(`No rates available for carrier "${carrier}"`), 400);
        }
      } else {
        // Auto-select cheapest overall rate.
        selectedRate = [...shipment.rates].sort(
          (a, b) => parseFloat(a.rate) - parseFloat(b.rate)
        )[0];
      }

      // Buy the selected rate.
      const purchased = await easypostRequest<EasyPostShipment>(
        c.env.EASYPOST_API_KEY,
        "POST",
        `/shipments/${shipment.id}/buy`,
        { rate: { id: selectedRate!.id } }
      );

      const labelUrl = purchased.postage_label?.label_url;
      const trackingNumber = purchased.tracking_code;

      if (!labelUrl || !trackingNumber) {
        return c.json(err("EasyPost returned an incomplete shipment — missing label or tracking number"), 502);
      }

      // Persist label and tracking info on the order.
      const updated = await db.updateOrder(id, {
        tracking_number: trackingNumber,
        label_url: labelUrl,
        shipping_carrier: selectedRate!.carrier,
        shipping_service: selectedRate!.service,
        fulfillment_status: "processing",
      });

      return c.json(
        ok({
          tracking_number: trackingNumber,
          label_url: labelUrl,
          carrier: selectedRate!.carrier,
          service: selectedRate!.service,
          rate: selectedRate!.rate,
          currency: selectedRate!.currency,
          delivery_days: selectedRate!.delivery_days,
          rates: shipment.rates,
          order: updated,
        })
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : "Unknown error";
      console.error(`POST /admin/orders/${id}/shipping-label error:`, e);
      return c.json(err(`Failed to generate shipping label: ${message}`), 502);
    }
  }
);

// ─── GET /admin/orders/:id/rates ──────────────────────────────────────────────
/**
 * Preview available shipping rates for an order without buying a label.
 * Useful for displaying rate options in the admin UI before committing.
 *
 * Query params:
 *   weight  number (ounces, required)
 *   length  number (inches, optional)
 *   width   number (inches, optional)
 *   height  number (inches, optional)
 *
 * Response data: { rates: EasyPostRate[] }
 */
shipping.get("/:id/rates", async (c) => {
  if (!c.env.EASYPOST_API_KEY) {
    return c.json(err("Shipping not configured — EASYPOST_API_KEY not set"), 503);
  }

  const id = c.req.param("id");
  const weightRaw = parseFloat(c.req.query("weight") ?? "");

  if (isNaN(weightRaw) || weightRaw <= 0) {
    return c.json(err("Query param `weight` (ounces) is required and must be a positive number"), 400);
  }

  const length = parseFloat(c.req.query("length") ?? "") || undefined;
  const width = parseFloat(c.req.query("width") ?? "") || undefined;
  const height = parseFloat(c.req.query("height") ?? "") || undefined;

  const db = getDatabase(c.env);
  const order = await db.getOrder(id);

  if (!order) return c.json(err("Order not found"), 404);

  if (!order.shipping_address_line1 || !order.shipping_city || !order.shipping_postal_code || !order.shipping_country) {
    return c.json(err("Order is missing a complete shipping address"), 400);
  }

  if (!c.env.STORE_ADDRESS_LINE1 || !c.env.STORE_CITY || !c.env.STORE_POSTAL_CODE || !c.env.STORE_COUNTRY) {
    return c.json(err("Store from-address is not configured in wrangler.toml"), 503);
  }

  try {
    const shipment = await easypostRequest<EasyPostShipment>(
      c.env.EASYPOST_API_KEY,
      "POST",
      "/shipments",
      {
        shipment: {
          to_address: {
            name: order.shipping_name ?? order.customer_name ?? "Customer",
            street1: order.shipping_address_line1,
            street2: order.shipping_address_line2 ?? undefined,
            city: order.shipping_city,
            state: order.shipping_state ?? undefined,
            zip: order.shipping_postal_code,
            country: order.shipping_country,
          },
          from_address: {
            name: c.env.STORE_NAME || "Store",
            street1: c.env.STORE_ADDRESS_LINE1,
            street2: c.env.STORE_ADDRESS_LINE2 || undefined,
            city: c.env.STORE_CITY,
            state: c.env.STORE_STATE || undefined,
            zip: c.env.STORE_POSTAL_CODE,
            country: c.env.STORE_COUNTRY,
            phone: c.env.STORE_PHONE || undefined,
          },
          parcel: { weight: weightRaw, length, width, height },
        },
      }
    );

    const sorted = [...(shipment.rates ?? [])].sort(
      (a, b) => parseFloat(a.rate) - parseFloat(b.rate)
    );

    return c.json(ok({ rates: sorted }));
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return c.json(err(`Failed to fetch rates: ${message}`), 502);
  }
});

export { shipping };
