// File-backed single-use store for redeemed payments. Survives restarts.
//
// We persist sha256(preimage) — never the raw preimage — alongside the
// macaroon expiry, so the file leaks nothing and prunes itself: an entry
// only matters while its macaroon could still be replayed (exp + slack).
// On Fly the machine disk survives restarts but not redeploys; combined
// with the short macaroon TTL that bounds the replay window acceptably.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

const PRUNE_SLACK_SECONDS = 3600;

export class ReplayStore {
  private spent = new Map<string, number>(); // sha256(preimage) -> exp
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  /** Returns false if already redeemed; records and persists otherwise. */
  redeemOnce(preimage: string, exp: number): boolean {
    const key = ReplayStore.digest(preimage);
    if (this.spent.has(key)) return false;
    this.spent.set(key, exp);
    try {
      appendFileSync(this.path, JSON.stringify({ k: key, exp }) + "\n");
    } catch (err) {
      // Persistence is best-effort; the in-memory set still guards this process.
      console.error(`replay-store: append failed: ${String(err)}`);
    }
    return true;
  }

  size(): number {
    return this.spent.size;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const now = Math.floor(Date.now() / 1000);
    let kept = 0;
    for (const line of readFileSync(this.path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const { k, exp } = JSON.parse(line) as { k: string; exp: number };
        if (typeof k === "string" && typeof exp === "number" && exp + PRUNE_SLACK_SECONDS > now) {
          this.spent.set(k, exp);
          kept++;
        }
      } catch {
        // tolerate corrupt lines
      }
    }
    // Compact: rewrite only the still-relevant entries.
    try {
      const lines = [...this.spent.entries()].map(([k, exp]) => JSON.stringify({ k, exp }));
      writeFileSync(this.path, lines.length ? lines.join("\n") + "\n" : "");
    } catch {
      /* best-effort */
    }
    if (kept > 0) console.error(`replay-store: loaded ${kept} unexpired redemption(s)`);
  }

  private static digest(preimage: string): string {
    return createHash("sha256").update(preimage.toLowerCase()).digest("hex");
  }
}
