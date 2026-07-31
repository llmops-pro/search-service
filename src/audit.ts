// NDJSON audit log — same shape/convention as the rest of the kit's servers.
// Append-only, never throws; IO failures degrade to stderr.
import { appendFileSync } from "node:fs";

export type AuditEvent =
  | "startup"
  | "nwc_warmup"
  | "challenge_issued"
  | "paid_search"
  | "replay_rejected"
  | "invalid_auth"
  | "not_settled"
  | "rate_limited"
  | "query_mismatch"
  | "backend_error"
  | "mint_error";

export class AuditLog {
  constructor(private readonly path: string) {}

  record(event: AuditEvent, fields: Record<string, unknown> = {}): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
    try {
      appendFileSync(this.path, line + "\n");
    } catch (err) {
      console.error(`audit: write failed (${String(err)}): ${line}`);
    }
  }
}
