/**
 * Cloud mirror: send each claim and its independent verdict to the Krett
 * ledger. Strictly fire-and-forget — verification never waits on the mirror,
 * a dead or slow ledger never changes a verdict, and errors are swallowed by
 * design. close() drains what is still in flight.
 */
import type {Claim, Verdict} from "@krett-ai/core";

export interface CloudOptions {
  apiKey: string;
  /** Ledger base URL; override for self-hosted planes. */
  url?: string;
}

export const DEFAULT_CLOUD_URL = "https://plane.krett.ai";

export class CloudMirror {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: CloudOptions) {
    this.url = (options.url ?? DEFAULT_CLOUD_URL).replace(/\/$/, "");
    this.apiKey = options.apiKey;
  }

  record(claim: Claim, verdict: Verdict, context?: Record<string, unknown>): void {
    const request = fetch(`${this.url}/v1/events`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({claim, verdict, ...(context ? {context} : {})}),
    })
      .catch(() => undefined)
      .finally(() => this.pending.delete(request));
    this.pending.add(request);
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.pending]);
  }
}
