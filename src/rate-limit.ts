// Rolling-60s-window rate limiter, per-key + global. In-memory by design —
// limits are a DoS valve, not an accounting system; losing them on restart
// is fine. The unpaid /search path mints a REAL invoice on our wallet per
// request, so the challenge bucket is the one that matters most.

export class RateLimiter {
  private hits = new Map<string, number[]>(); // key -> timestamps (ms)
  private globalHits: number[] = [];

  constructor(
    private readonly perKeyPerMin: number,
    private readonly globalPerMin: number,
  ) {}

  /** Returns true if this hit is allowed (and records it). */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;

    this.globalHits = this.globalHits.filter((t) => t > cutoff);
    if (this.globalHits.length >= this.globalPerMin) return false;

    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length >= this.perKeyPerMin) {
      this.hits.set(key, list);
      return false;
    }

    list.push(now);
    this.hits.set(key, list);
    this.globalHits.push(now);

    // Opportunistic cleanup so the map can't grow unbounded under key churn.
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) {
        if (v.every((t) => t <= cutoff)) this.hits.delete(k);
      }
    }
    return true;
  }
}

/** Client IP: Fly sets Fly-Client-IP; fall back to XFF's first hop, then a fixed key. */
export function clientIp(headers: Headers): string {
  return (
    headers.get("fly-client-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}
