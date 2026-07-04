// Minimal L402 macaroon mint/verify.
//
// v0 simplification: the "macaroon" is an HMAC-signed token binding a
// payment_hash + expiry. Real L402 macaroons carry richer caveats (tiers,
// per-query binding); this is enough to bind a paid invoice to a redemption.
// TODO: migrate to a proper macaroon lib with caveats before "public".
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// q_hash binds the macaroon to the query that was paid for (first 16 hex
// chars of sha256 of the trimmed query) — a paid token can't be redeemed
// for a different search.
export type MacaroonClaims = { payment_hash: string; exp: number; q_hash: string };

/** Caveat digest binding a macaroon to its query. */
export function queryHash(q: string): string {
  return createHash("sha256").update(q.trim()).digest("hex").slice(0, 16);
}

export function mintMacaroon(
  claims: MacaroonClaims,
  secret: string,
): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = sign(payload, secret);
  return `${payload}.${sig}`;
}

export function verifyMacaroon(
  token: string,
  secret: string,
): MacaroonClaims | null {
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return null;
  const expected = sign(payload, secret);
  if (!safeEqual(sig, expected)) return null;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf-8"),
    ) as MacaroonClaims;
    if (
      typeof claims.payment_hash !== "string" ||
      typeof claims.exp !== "number" ||
      typeof claims.q_hash !== "string"
    ) {
      return null;
    }
    if (Date.now() / 1000 > claims.exp) return null; // expired
    return claims;
  } catch {
    return null;
  }
}

/** Build the `WWW-Authenticate: L402 ...` challenge header value. */
export function l402Challenge(macaroon: string, invoice: string): string {
  return `L402 macaroon="${macaroon}", invoice="${invoice}"`;
}

/** Parse `Authorization: L402 <macaroon>:<preimage>` → {macaroon, preimage}. */
export function parseL402Auth(
  header: string | undefined,
): { macaroon: string; preimage: string } | null {
  if (!header) return null;
  const m = header.match(/^L402\s+([^:\s]+):([0-9a-fA-F]+)$/);
  if (!m) return null;
  return { macaroon: m[1]!, preimage: m[2]! };
}

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}
