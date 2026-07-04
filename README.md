# search-service (M2) — no-KYC, sats-metered web search for agents

The **public** instance of agent-pays-per-call. Where `paywall-mcp` + `tavily-mcp` proved the
loop in a closed dogfood (M1, stdio, our own agent paying itself), this is the open endpoint a
**stranger's** agent can hit: pay an invoice, get search results, **no account, no API key, no
KYC**.

Design origin: [`04-paid-mcp-service-design.md`](../04-paid-mcp-service-design.md) §M2.
Grant framing: [`07-grant-strategy.md`](../07-grant-strategy.md). This is product #7.

> **Status: v0 SCAFFOLD.** The L402 flow, NWC invoicing, and SearXNG client are implemented as a
> coherent skeleton with `TODO`s for hardening (macaroon caveats, replay store, rate limiting,
> abuse control). It runs locally against a SearXNG instance; it is not yet production-hardened.

---

## Why this shape

- **L402 over HTTP** (not stdio MCP) because the buyer is an arbitrary remote agent, not a local
  child process. L402 = HTTP 402 + a Lightning invoice in `WWW-Authenticate`; the client pays,
  then retries with the preimage as proof. The **preimage itself is the proof of payment**
  (`sha256(preimage) == payment_hash`) — no trust, no lookup needed (we still lookup as
  belt-and-suspenders).
- **Self-hosted SearXNG backend** — "no-KYC all the way down." Reselling a KYC'd API (Tavily/Brave)
  would (a) likely breach their ToS and (b) reintroduce the surveillance rail we're removing.
  SearXNG aggregates public engines with no account.
- **Receive-only NWC sub-wallet** — the service can mint + look up invoices but cannot spend. Same
  trust boundary as `paywall-mcp`. The nsec / spend keys never touch this box — which is why
  hosting it on **Fly.io is an acceptable trust trade** (only a receive-only invoice key lives
  there, not the wallet's spending authority or any signing key).

```
  agent ──GET /search?q=...──────────────▶ search-service
        ◀── 402 + L402(invoice, macaroon) ─┘   (mint invoice via receive-only NWC)
   pays invoice (Lightning) ─────────────────▶ wallet settles
        ──GET /search + L402(macaroon:preimage)▶ verify sha256(preimage)==payment_hash
        ◀──────────── results (JSON) ──────────┘   (query self-hosted SearXNG)
```

## Run locally

```sh
cp .env.example .env        # fill RECEIVE NWC + SEARXNG_URL + MACAROON_SECRET
pnpm install
pnpm dev                    # starts the HTTP server on PORT (default 8088)
# in another shell, point SEARXNG_URL at a local SearXNG (docker-compose up searxng)
```

## Endpoints (v0)

- `GET /healthz` — liveness, no payment.
- `GET /search?q=<query>` — the paid endpoint. Returns 402 + invoice if unpaid; results if the
  `Authorization: L402 <macaroon>:<preimage>` header validates.
- `GET /` — human landing page describing the no-KYC offer + how to pay.

## Deploy (Fly.io)

`fly.toml` + `Dockerfile` deploy the service. SearXNG runs as a **separate** Fly app (or any
reachable SearXNG); set `SEARXNG_URL` to it. See `docker-compose.yml` for the local two-service
setup. Keep only the **receive-only** NWC string in Fly secrets.

## TODO before "public"

- [ ] Macaroon caveats (expiry enforced ✓; add per-query binding, tier caveats).
- [ ] Persistent replay store for spent preimages (currently in-memory Set — resets on restart).
- [ ] Rate limiting + abuse controls (per-IP pre-payment throttle; SearXNG can be hammered).
- [ ] Price oracle / dynamic pricing; currently a flat `PRICE_SATS`.
- [ ] Observability + audit log (reuse the kit's NDJSON shape).
- [ ] Publish a thin `search-mcp` client so MCP agents can consume it without hand-rolling L402.
