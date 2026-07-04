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

  async mint(amountSats: number, memo: string): Promise<MintedInvoice> {
    const res = await this.client.makeInvoice({
      amount: amountSats * 1000, // msat
      description: memo,
    });
    return {
      invoice: res.invoice,
      payment_hash: res.payment_hash,
      amount_sats: amountSats,
    };
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
