/**
 * @krett/recover — the recovery ladder behind the engine's dispatcher seam.
 *
 * Recovery law: nothing here trusts its own success. A retry counts as
 * recovered only when an INDEPENDENT re-check verifies the world; a rollback
 * counts only when its verification confirms the world is back. `unverifiable`
 * never counts as recovered — that is the same one-safe-direction rule the
 * engine follows (a checker that proved nothing recovered nothing).
 *
 * Quarantine is an exact boundary: it applies to one agentId, takes effect
 * the moment it is decided, and a quarantined agent gets no further retries
 * or rollbacks through this dispatcher — its failures are recorded and
 * routed straight back to quarantine until a human lifts it.
 */
import type {
  Claim,
  RecoveryAction,
  RecoveryDispatcher,
  RecoveryType,
  Verdict,
} from "@krett/core";

/** Redo or undo an action, then prove it through an independent check. */
export interface VerifiedHandler {
  execute(claim: Claim): Promise<void>;
  verify(claim: Claim): Promise<Verdict>;
}

export type EscalateHandler = (claim: Claim, verdict: Verdict) => Promise<void>;
export type QuarantineHandler = (agentId: string, claim: Claim) => Promise<void>;

export interface LadderRecoveryOptions {
  retry?: VerifiedHandler;
  rollback?: VerifiedHandler;
  /** Page a human. Escalation without a wired channel is skipped, not faked. */
  escalate?: EscalateHandler;
  /** Optional side effect (revoke keys, pause the worker); the local boundary holds regardless. */
  quarantine?: QuarantineHandler;
}

export class LadderRecovery implements RecoveryDispatcher {
  private readonly handlers: LadderRecoveryOptions;
  private readonly quarantined = new Set<string>();

  constructor(handlers: LadderRecoveryOptions = {}) {
    this.handlers = handlers;
  }

  isQuarantined(agentId: string): boolean {
    return this.quarantined.has(agentId);
  }

  /** Human decision, by design: nothing in this package lifts a quarantine automatically. */
  lift(agentId: string): void {
    this.quarantined.delete(agentId);
  }

  async dispatch(
    claim: Claim,
    verdict: Verdict,
    ladder: RecoveryType[],
    maxRetries: number,
  ): Promise<RecoveryAction[]> {
    if (this.quarantined.has(claim.agentId)) {
      return [
        action("quarantine", claim, "recovered",
          `agent ${claim.agentId} is already quarantined; no recovery side effects run`),
      ];
    }

    const actions: RecoveryAction[] = [];
    for (const step of ladder) {
      const result = await this.runStep(step, claim, verdict, maxRetries);
      actions.push(result);
      if (result.outcome === "recovered") break;
    }
    return actions;
  }

  private async runStep(
    step: RecoveryType,
    claim: Claim,
    verdict: Verdict,
    maxRetries: number,
  ): Promise<RecoveryAction> {
    switch (step) {
      case "retry":
        return this.runVerified("retry", this.handlers.retry, claim, Math.max(1, maxRetries));
      case "rollback":
        return this.runVerified("rollback", this.handlers.rollback, claim, 1);
      case "escalate":
        return this.runEscalate(claim, verdict);
      case "quarantine":
        return this.runQuarantine(claim);
    }
  }

  private async runVerified(
    type: "retry" | "rollback",
    handler: VerifiedHandler | undefined,
    claim: Claim,
    attempts: number,
  ): Promise<RecoveryAction> {
    if (!handler) return action(type, claim, "skipped", `no ${type} handler wired`);
    let lastDetail = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await handler.execute(claim);
        const recheck = await handler.verify(claim);
        if (recheck.status === "verified") {
          return action(type, claim, "recovered",
            `${type} verified independently on attempt ${attempt}`);
        }
        // `failed` and `unverifiable` both fall through: unproven is unrecovered.
        lastDetail = `attempt ${attempt}: re-check ${recheck.status}` +
          (recheck.reason ? ` (${recheck.reason})` : "");
      } catch (error) {
        lastDetail = `attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    return action(type, claim, "failed", lastDetail);
  }

  private async runEscalate(claim: Claim, verdict: Verdict): Promise<RecoveryAction> {
    if (!this.handlers.escalate) {
      return action("escalate", claim, "skipped", "no escalation channel wired");
    }
    try {
      await this.handlers.escalate(claim, verdict);
      return action("escalate", claim, "recovered", "escalated to a human");
    } catch (error) {
      return action("escalate", claim, "failed",
        `escalation channel failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async runQuarantine(claim: Claim): Promise<RecoveryAction> {
    // The local boundary is authoritative and takes effect before any side effect runs.
    this.quarantined.add(claim.agentId);
    let detail = `agent ${claim.agentId} quarantined`;
    if (this.handlers.quarantine) {
      try {
        await this.handlers.quarantine(claim.agentId, claim);
      } catch (error) {
        detail += `; external quarantine hook failed: ${
          error instanceof Error ? error.message : String(error)
        } (local boundary still holds)`;
      }
    }
    return action("quarantine", claim, "recovered", detail);
  }
}

function action(
  type: RecoveryType,
  claim: Claim,
  outcome: RecoveryAction["outcome"],
  detail: string,
): RecoveryAction {
  return {type, claimId: claim.id, outcome, detail, timestamp: Date.now()};
}
