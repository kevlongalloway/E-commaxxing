import type { Database, Bindings } from "../types.js";
import { D1Database } from "./d1.js";
import { MongoDatabase } from "./mongo.js";
export { calculateDiscountAmount } from "../types.js";

/**
 * Returns the configured database adapter.
 *
 * DB_ADAPTER = "d1"      → Cloudflare D1 (default, recommended)
 * DB_ADAPTER = "mongodb" → MongoDB Atlas (requires MONGODB_URI secret)
 */
export function getDatabase(env: Bindings): Database {
  const adapter = (env.DB_ADAPTER ?? "d1").toLowerCase();

  if (adapter === "mongodb") {
    if (!env.MONGODB_URI) {
      throw new Error(
        "DB_ADAPTER is set to 'mongodb' but MONGODB_URI secret is not configured. " +
          "Run: wrangler secret put MONGODB_URI"
      );
    }
    return new MongoDatabase(env.MONGODB_URI, env.MONGODB_DB_NAME ?? "ecommaxxing");
  }

  // Default: D1
  if (!env.DB) {
    throw new Error(
      "D1 database binding 'DB' is not available. " +
        "Check your wrangler.toml [[d1_databases]] configuration."
    );
  }
  return new D1Database(env.DB);
}
