// search-service — L402-gated, no-KYC, sats-metered web search for agents.
// Pipeline per request: rate-limit → (unpaid: mint invoice + macaroon, 402)
// or (paid: verify macaroon + preimage + query binding + settlement →
// single-use redeem → search). Every outcome is audited.
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { AuditLog } from "./audit.js";
import { loadConfig } from "./config.js";
import { PaymentGate } from "./payment.js";
import { RateLimiter, clientIp } from "./rate-limit.js";
import { ReplayStore } from "./replay-store.js";
import { searxngSearch } from "./searxng.js";
import {
  l402Challenge,
  mintMacaroon,
  parseL402Auth,
  queryHash,
  verifyMacaroon,
} from "./l402.js";

const config = loadConfig();
const gate = new PaymentGate(config.RECEIVE_NWC_CONNECTION_STRING);
const replay = new ReplayStore(config.REPLAY_STORE_PATH);
const audit = new AuditLog(config.AUDIT_LOG_PATH);
const challengeLimiter = new RateLimiter(
  config.RATE_CHALLENGE_PER_MIN,
  config.RATE_CHALLENGE_GLOBAL_PER_MIN,
);
const redeemLimiter = new RateLimiter(
  config.RATE_REDEEM_PER_MIN,
  config.RATE_REDEEM_GLOBAL_PER_MIN,
);
const app = new Hono();

app.get("/healthz", (c) => c.json({ ok: true, service: "search-service", version: "0.1.0" }));

// 402index.io domain-verification file. The hash is safe to serve publicly —
// the raw verification token stays local (.402index-token, never deployed).
app.get("/.well-known/402index-verify.txt", (c) =>
  c.text("586e331e11a3f75f6865b011865e8be7ca4bc87e6ca4cd165d30c30f167af6f8"),
);

// Aggregate funnel counters — no queries, IPs, or payment hashes exposed.
// since_boot counters reset on deploy/restart; redeemed_active is the replay
// store's live window (survives restarts, prunes with macaroon expiry).
const stats = { challenges_issued: 0, paid_searches: 0 };
const bootedAt = new Date().toISOString();
app.get("/stats", (c) =>
  c.json({
    service: "search-service",
    booted_at: bootedAt,
    since_boot: stats,
    redeemed_active: replay.size(),
    price_sats: config.PRICE_SATS,
  }),
);

app.get("/", (c) =>
  c.html(`<!doctype html><meta charset=utf-8><title>No-KYC Sats Search for Agents</title>
<body style="font-family:system-ui;max-width:40rem;margin:3rem auto;line-height:1.5">
<h1>⚡ No-KYC, sats-metered web search for agents</h1>
<p>Pay per search in Lightning sats. No account, no API key, no KYC.</p>
<p><code>GET /search?q=your+query</code> → <b>402</b> with a Lightning invoice. Pay it, then retry
the <b>same query</b> with <code>Authorization: L402 &lt;macaroon&gt;:&lt;preimage&gt;</code> to get JSON results.</p>
<p>Price: <b>${config.PRICE_SATS} sats</b> / search. Built on the open
<a href="https://github.com/llmops-pro">LLMOps.Pro</a> agent-payments kit.</p>
</body>`),
);

app.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q || q.trim().length === 0) {
    return c.json({ error: "missing query param ?q=" }, 400);
  }
  const ip = clientIp(c.req.raw.headers);
  const auth = parseL402Auth(c.req.header("Authorization"));

  // --- Unpaid path: mint an invoice + macaroon, return 402 ------------------
  if (!auth) {
    if (!challengeLimiter.allow(ip)) {
      audit.record("rate_limited", { ip, path: "challenge" });
      return c.json({ error: "rate limited — slow down" }, 429);
    }
    const memo = `search-service: "${q.slice(0, 64)}"`;
    let minted;
    try {
      minted = await gate.mint(config.PRICE_SATS, memo);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      audit.record("mint_error", { ip, error: msg.slice(0, 200) });
      return c.json({ error: `could not mint invoice: ${msg}` }, 502);
    }
    const macaroon = mintMacaroon(
      {
        payment_hash: minted.payment_hash,
        exp: Math.floor(Date.now() / 1000) + config.MACAROON_TTL_SECONDS,
        q_hash: queryHash(q),
      },
      config.MACAROON_SECRET,
    );
    stats.challenges_issued++;
    audit.record("challenge_issued", {
      ip,
      payment_hash: minted.payment_hash,
      amount_sats: minted.amount_sats,
      q: q.slice(0, 80),
    });
    c.header("WWW-Authenticate", l402Challenge(macaroon, minted.invoice));
    return c.json(
      {
        error: "payment required",
        l402: {
          macaroon,
          invoice: minted.invoice,
          payment_hash: minted.payment_hash,
          amount_sats: minted.amount_sats,
        },
        next:
          "pay the invoice, then retry the SAME query with header: Authorization: L402 <macaroon>:<preimage>",
      },
      402,
    );
  }

  // --- Paid path: verify macaroon + preimage + query + settlement -----------
  if (!redeemLimiter.allow(ip)) {
    audit.record("rate_limited", { ip, path: "redeem" });
    return c.json({ error: "rate limited — slow down" }, 429);
  }
  const claims = verifyMacaroon(auth.macaroon, config.MACAROON_SECRET);
  if (!claims) {
    audit.record("invalid_auth", { ip, reason: "bad_or_expired_macaroon" });
    return c.json({ error: "invalid or expired macaroon" }, 401);
  }
  if (claims.q_hash !== queryHash(q)) {
    audit.record("query_mismatch", { ip, payment_hash: claims.payment_hash });
    return c.json({ error: "macaroon was paid for a different query — retry with the original query" }, 401);
  }
  if (!PaymentGate.preimageMatches(auth.preimage, claims.payment_hash)) {
    audit.record("invalid_auth", { ip, reason: "preimage_mismatch", payment_hash: claims.payment_hash });
    return c.json({ error: "preimage does not match macaroon payment_hash" }, 401);
  }
  // belt-and-suspenders: confirm settlement on our own wallet
  if (!(await gate.isSettled(claims.payment_hash))) {
    audit.record("not_settled", { ip, payment_hash: claims.payment_hash });
    return c.json({ error: "invoice not settled yet" }, 402);
  }
  // single-use (persisted across restarts)
  if (!replay.redeemOnce(auth.preimage, claims.exp)) {
    audit.record("replay_rejected", { ip, payment_hash: claims.payment_hash });
    return c.json({ error: "this payment was already redeemed" }, 409);
  }

  try {
    const results = await searxngSearch(config.SEARXNG_URL, q);
    stats.paid_searches++;
    audit.record("paid_search", {
      ip,
      payment_hash: claims.payment_hash,
      amount_sats: config.PRICE_SATS,
      q: q.slice(0, 80),
      results: results.length,
    });
    return c.json({ query: q, count: results.length, results });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Payment already consumed but search failed — surfaced in audit for a
    // manual refund/credit policy until an automatic one exists.
    audit.record("backend_error", { ip, payment_hash: claims.payment_hash, error: msg.slice(0, 200) });
    return c.json({ error: `search backend failed: ${msg}` }, 502);
  }
});

const warmupStarted = Date.now();
await gate.warmUp();
audit.record("nwc_warmup", { duration_ms: Date.now() - warmupStarted });

serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  audit.record("startup", {
    port: info.port,
    price_sats: config.PRICE_SATS,
    backend: config.SEARXNG_URL,
    replay_entries: replay.size(),
  });
  console.error(
    `search-service listening on :${info.port} | price ${config.PRICE_SATS} sats | backend ${config.SEARXNG_URL} | replay store: ${replay.size()} entries`,
  );
});
