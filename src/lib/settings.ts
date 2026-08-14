import type { Database, HeaderVideo, StorefrontSettings } from "../types.js";

/**
 * Storefront settings live in a key/value table, so reads must survive a key
 * that was never written, or that was written by an older version with fewer
 * fields. Everything here normalizes to a complete object — the storefront
 * always receives the same shape, with nulls for anything unset.
 */

export const SETTING_KEYS = {
  headerVideo: "header_video",
} as const;

export const DEFAULT_HEADER_VIDEO: HeaderVideo = {
  desktop_url: null,
  mobile_url: null,
  poster_url: null,
};

/** Coerces anything read out of the store into a valid HeaderVideo. */
function normalizeHeaderVideo(stored: unknown): HeaderVideo {
  if (!stored || typeof stored !== "object") return { ...DEFAULT_HEADER_VIDEO };

  const raw = stored as Record<string, unknown>;
  const str = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 ? value : null;

  return {
    desktop_url: str(raw.desktop_url),
    mobile_url: str(raw.mobile_url),
    poster_url: str(raw.poster_url),
  };
}

export async function getHeaderVideo(db: Database): Promise<HeaderVideo> {
  return normalizeHeaderVideo(await db.getSetting<unknown>(SETTING_KEYS.headerVideo));
}

export async function saveHeaderVideo(
  db: Database,
  value: HeaderVideo
): Promise<HeaderVideo> {
  return db.setSetting<HeaderVideo>(SETTING_KEYS.headerVideo, value);
}

/** Everything the storefront needs from GET /settings, in one object. */
export async function getStorefrontSettings(db: Database): Promise<StorefrontSettings> {
  return {
    header_video: await getHeaderVideo(db),
  };
}
