/**
 * Email checker: verifies "I sent that email" by reading the sending
 * provider's records through the checker's OWN credentials (AGENTS.md #10) —
 * never by trusting the agent's claim that a send call succeeded.
 *
 * Claim conventions (system: "email"):
 *   entity: "message:<ref>" where <ref> is whatever the provider lookup
 *           understands (typically the provider message id).
 *   expect: dot-path -> expected value over the provider's message record
 *           ("to", "subject", "last_event": "delivered").
 *           "$exists": false asserts no such message exists.
 *
 * The provider lookup is injected. `resendProvider` ships as a zero-dependency
 * option; any function that resolves a ref to a message record (IMAP search,
 * SendGrid, a test inbox) fits the same seam.
 */
import type {Checker, CheckerContext, Claim, Verdict} from "@krett/core";
import {compareExpect} from "./match.js";

export type EmailLookup = (ref: string) => Promise<Record<string, unknown> | null>;

type FetchLike = (url: string, init?: {headers?: Record<string, string>}) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

/** Look up a message by id in Resend with the checker's own API key. */
export function resendProvider(options: {apiKey: string; fetchFn?: FetchLike}): EmailLookup {
  const fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
  return async (ref) => {
    const response = await fetchFn(`https://api.resend.com/emails/${encodeURIComponent(ref)}`, {
      headers: {authorization: `Bearer ${options.apiKey}`},
    });
    if (response.status === 404) return null;
    if (response.status !== 200) {
      throw new Error(`resend answered ${response.status}`);
    }
    return (await response.json()) as Record<string, unknown>;
  };
}

export class EmailChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly lookup: EmailLookup;

  constructor(options: {lookup: EmailLookup; id?: string}) {
    this.id = options.id ?? "email";
    this.lookup = options.lookup;
  }

  supports(claim: Claim): boolean {
    return claim.action.system === "email" && claim.action.entity.startsWith("message:");
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const ref = claim.action.entity.slice("message:".length);
    if (!ref) {
      return this.verdict(claim, started, "unverifiable", null,
        'entity must be "message:<providerRef>"');
    }

    let message: Record<string, unknown> | null;
    try {
      message = await this.lookup(ref);
    } catch (error) {
      return this.verdict(claim, started, "unverifiable", null,
        `email lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const expect = claim.action.expect;
    const wantsAbsence = expect["$exists"] === false;
    if (message === null) {
      return wantsAbsence
        ? this.verdict(claim, started, "verified", {exists: false})
        : this.verdict(claim, started, "failed", {exists: false},
            `no message found for ref "${ref}" — the send the agent claimed is not in the provider's records`);
    }
    if (wantsAbsence) {
      return this.verdict(claim, started, "failed", {exists: true},
        "expected no message, but the provider has one");
    }

    const problem = compareExpect(message, expect);
    return problem
      ? this.verdict(claim, started, "failed", {message}, problem)
      : this.verdict(claim, started, "verified", {message});
  }

  private verdict(
    claim: Claim,
    started: number,
    status: Verdict["status"],
    evidence: unknown,
    reason?: string,
  ): Verdict {
    return {
      claimId: claim.id,
      status,
      checkerId: this.id,
      evidence,
      ...(reason ? {reason} : {}),
      latencyMs: Date.now() - started,
      timestamp: Date.now(),
    };
  }
}
