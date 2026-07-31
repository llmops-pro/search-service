// NWC invoicing for the L402 flow. Mints invoices on a RECEIVE-ONLY sub-wallet
// and verifies payment. The preimage is self-proving (sha256(preimage) ==
// payment_hash); we also lookup as belt-and-suspenders.
import { createHash } from "node:crypto";
import { nwc } from "@getalby/sdk";

export type MintedInvoice = {
  invoice: string;
  payment_hash: string;
  amount_sats: number;
};

export class PaymentGate {
  private client: nwc.NWCClient;

  constructor(connectionString: string) {
    this.client = new nwc.NWCClient({ nostrWalletConnectUrl: connectionString });
  }

  /**
   * Force the NWC relay connection open before the server starts accepting
   * traffic. On Fly's scale-to-zero, the machine becomes reachable to the
   * proxy well before the relay websocket handshake completes — without this,
   * the first request after a cold wake can race make_invoice against that
   * handshake and fail. Any in-scope round-trip forces the connection open
   * even if the call itself errors (e.g. "not found"), so failures here are
   * swallowed on purpose; a timeout just means startup proceeds un-warmed.
   */
  async warmUp(timeoutMs = 8000): Promise<void> {
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
    const probe = this.client
      .lookupInvoice({ payment_hash: "0".repeat(64) })
      .then(() => undefined)
      .catch(() => undefined);
    await Promise.race([probe, timeout]);
  }

  async mint(amountSats: number, memo: string, retries = 2): Promise<MintedInvoice> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.client.makeInvoice({
          amount: amountSats * 1000, // msat
          description: memo,
        });
        return {
          invoice: res.invoice,
          payment_hash: res.payment_hash,
          amount_sats: amountSats,
        };
      } catch (err) {
        lastErr = err;
        if (attempt < retries) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw lastErr;
  }

  /** Self-proving check: does this preimage hash to the bound payment_hash? */
  static preimageMatches(preimage: string, paymentHash: string): boolean {
    if (!/^[0-9a-f]{64}$/i.test(preimage)) return false;
    const hash = createHash("sha256")
      .update(Buffer.from(preimage, "hex"))
      .digest("hex");
    return hash.toLowerCase() === paymentHash.toLowerCase();
  }

  /** Belt-and-suspenders: confirm settlement on our own wallet. */
  async isSettled(paymentHash: string): Promise<boolean> {
    try {
      const inv = await this.client.lookupInvoice({ payment_hash: paymentHash });
      return Boolean(inv.settled_at);
    } catch {
      return false;
    }
  }

  close(): void {
    this.client.close?.();
  }
}
