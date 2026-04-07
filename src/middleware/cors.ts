import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../types.js";

/**
 * CORS middleware.
 *
 * Reads allowed origins from `CORS_ORIGINS` (comma-separated or "*").
 * Reads allowed methods from `CORS_METHODS`.
 *
 * Configure in wrangler.toml:
 *   CORS_ORIGINS = "https://myshop.com,https://www.myshop.com"
 *   CORS_METHODS = "GET,POST,PUT,DELETE,OPTIONS"
 */
export const corsMiddleware = (): MiddlewareHandler<{ Bindings: Bindings }> => {
  return async (c, next) => {
    const allowedOrigins = (c.env.CORS_ORIGINS ?? "*")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);

    const allowedMethods = c.env.CORS_METHODS ?? "GET,POST,PUT,DELETE,OPTIONS";
    const requestOrigin = c.req.header("Origin") ?? "";

    // Determine the value to echo back in Access-Control-Allow-Origin
    let originHeader: string;
    if (allowedOrigins.includes("*")) {
      originHeader = "*";
    } else if (allowedOrigins.includes(requestOrigin)) {
      originHeader = requestOrigin;
    } else {
      // Unknown origin — still process the request but don't add CORS headers.
      // The browser will block it; server-to-server calls won't send Origin.
      await next();
      return;
    }

    // Handle pre-flight (OPTIONS) requests immediately — no further processing needed.
    if (c.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": originHeader,
          "Access-Control-Allow-Methods": allowedMethods,
          "Access-Control-Allow-Headers":
            "Content-Type, Authorization, X-CSRF-Token",
          "Access-Control-Max-Age": "86400",
          ...(originHeader !== "*" ? { Vary: "Origin" } : {}),
        },
      });
    }

    await next();

    c.res.headers.set("Access-Control-Allow-Origin", originHeader);
    c.res.headers.set("Access-Control-Allow-Methods", allowedMethods);
    c.res.headers.set(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-CSRF-Token"
    );
    if (originHeader !== "*") {
      c.res.headers.set("Vary", "Origin");
    }
  };
};
