// Env-driven config. Receive-only NWC + SearXNG backend + flat price.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Load .env from the package root only (never cwd — same convention as the
// other kit servers). Real env vars always win over .env values, so Docker
// env_file / fly secrets behave identically with or without a local .env.
function loadDotenv(): void {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  let raw: string;
  try {
    raw = readFileSync(join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const ConfigZ = z.object({
  PORT: z.coerce.number().int().positive().default(8088),
  // Receive-only NWC connection string (make_invoice + lookup_invoice scope).
  // NEVER put a spend-capable connection here.
  RECEIVE_NWC_CONNECTION_STRING: z.string().startsWith("nostr+walletconnect://"),
  // Base URL of a self-hosted SearXNG instance exposing the JSON API.
  SEARXNG_URL: z.string().url(),
  // Flat price per search, in sats.
  PRICE_SATS: z.coerce.number().int().positive().default(50),
  // HMAC secret for minting/verifying L402 macaroons. Generate 32+ random bytes.
  MACAROON_SECRET: z.string().min(16),
  // Macaroon validity window (seconds) — how long a minted invoice/token is good for.
  MACAROON_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  // Optional public base URL (for the landing page / docs links).
  PUBLIC_URL: z.string().url().optional(),
  // File the single-use (anti-replay) store persists to across restarts.
  REPLAY_STORE_PATH: z.string().default("./replay-store.ndjson"),
  // NDJSON audit log path (same convention as the other kit servers).
  AUDIT_LOG_PATH: z.string().default("./search-service-audit.log"),
  // Unpaid 402s mint a real invoice each — keep this bucket tight.
  RATE_CHALLENGE_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_CHALLENGE_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(60),
  // Paid/redeem attempts per IP per minute.
  RATE_REDEEM_PER_MIN: z.coerce.number().int().positive().default(30),
  RATE_REDEEM_GLOBAL_PER_MIN: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof ConfigZ>;

export function loadConfig(): Config {
  loadDotenv();
  const parsed = ConfigZ.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid search-service config:\n${issues}`);
  }
  return parsed.data;
}
