/**
 * JWT utilities using the Web Crypto API (Cloudflare Workers compatible).
 * Uses HMAC-SHA256 for signing.
 */

const DEFAULT_EXPIRY_SECONDS = 8 * 60 * 60; // 8 hours

function base64urlEncode(input: ArrayBuffer | string): string {
  const bytes =
    typeof input === "string"
      ? new TextEncoder().encode(input)
      : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64urlDecode(input: string): Uint8Array {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function importHmacKey(
  secret: string,
  usage: "sign" | "verify"
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

export interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

/**
 * Creates a signed JWT with HMAC-SHA256.
 *
 * @param payload   Custom claims to include (sub is required).
 * @param secret    Secret key from `JWT_SECRET` env var.
 * @param expiresIn Lifetime in seconds. Defaults to 8 hours.
 */
export async function signJWT(
  payload: Omit<JwtPayload, "iat" | "exp">,
  secret: string,
  expiresIn = DEFAULT_EXPIRY_SECONDS
): Promise<string> {
  const header = base64urlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const body = base64urlEncode(
    JSON.stringify({ ...payload, iat: now, exp: now + expiresIn })
  );

  const data = `${header}.${body}`;
  const key = await importHmacKey(secret, "sign");
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(data)
  );

  return `${data}.${base64urlEncode(signature)}`;
}

/**
 * Verifies a JWT's signature and expiry.
 *
 * Returns the decoded payload on success, or `null` if the token is
 * invalid, tampered with, or expired.
 */
export async function verifyJWT(
  token: string,
  secret: string
): Promise<JwtPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  const data = `${headerB64}.${payloadB64}`;

  let valid: boolean;
  try {
    const key = await importHmacKey(secret, "verify");
    valid = await crypto.subtle.verify(
      "HMAC",
      key,
      base64urlDecode(signatureB64),
      new TextEncoder().encode(data)
    );
  } catch {
    return null;
  }

  if (!valid) return null;

  let payload: JwtPayload;
  try {
    payload = JSON.parse(
      new TextDecoder().decode(base64urlDecode(payloadB64))
    ) as JwtPayload;
  } catch {
    return null;
  }

  if (payload.exp < Math.floor(Date.now() / 1000)) return null;

  return payload;
}
