/**
 * The claim/verdict engine.
 *
 * submit() routes a Claim to the first supporting Checker (respecting the
 * policy's checker order for the claim's consequence level), persists the
 * Verdict, and on `failed` dispatches the recovery ladder. A checker crash or
 * an unsupported claim yields `unverifiable` — the engine can be wrong in only
 * one safe direction, never toward `verified`.
 */
import {EventEmitter} from "node:events";
import {randomUUID} from "node:crypto";
import type {
  Checker,
  Claim,
  FailureRecord,
  Policy,
  RecoveryAction,
  RecoveryDispatcher,
  Verdict,
} from "./types.js";
import {defaultPolicy} from "./types.js";
import type {StorageAdapter} from "./storage.js";
import {MemoryStorage} from "./storage.js";

export interface EngineOptions {
  checkers: Checker[];
  policy?: Policy;
  storage?: StorageAdapter;
  recovery?: RecoveryDispatcher;
}

export interface SubmitOptions {
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

/** Recovery seam default: record the failure, resolve nothing. */
class NoopRecovery implements RecoveryDispatcher {
  async dispatch(): Promise<RecoveryAction[]> {
    return [];
  }
}

export class KrettEngine extends EventEmitter {
  private readonly checkers: Checker[];
  private readonly policy: Policy;
  private readonly storage: StorageAdapter;
  private readonly recovery: RecoveryDispatcher;

  constructor(options: EngineOptions) {
    super();
    this.checkers = [...options.checkers];
    this.policy = options.policy ?? defaultPolicy;
    this.storage = options.storage ?? new MemoryStorage();
    this.recovery = options.recovery ?? new NoopRecovery();
  }

  /** Route per policy: explicit checker order first, else registration order. */
  private selectChecker(claim: Claim): Checker | null {
    const order = this.policy.levels[claim.consequence].checkers;
    const pool =
      order.length === 0
        ? this.checkers
        : order
            .map((id) => this.checkers.find((c) => c.id === id))
            .filter((c): c is Checker => c !== undefined);
    return pool.find((c) => c.supports(claim)) ?? null;
  }

  async submit(claim: Claim, options: SubmitOptions = {}): Promise<Verdict> {
    await this.storage.saveClaim(claim);
    this.emit("claim", claim);

    const verdict = await this.runCheck(claim, options.signal);
    await this.storage.saveVerdict(verdict);
    this.emit("verdict", verdict);

    if (verdict.status === "failed") {
      await this.handleFailure(claim, verdict, options.context ?? {});
    }
    return verdict;
  }

  private async runCheck(claim: Claim, signal?: AbortSignal): Promise<Verdict> {
    const started = Date.now();
    const checker = this.selectChecker(claim);
    if (!checker) {
      return {
        claimId: claim.id,
        status: "unverifiable",
        checkerId: "none",
        evidence: null,
        reason: "no registered checker supports this claim",
        latencyMs: Date.now() - started,
        timestamp: Date.now(),
      };
    }
    try {
      return await checker.check(claim, signal ? {signal} : {});
    } catch (error) {
      // A crashed checker proved nothing. Unverifiable, never verified or failed.
      return {
        claimId: claim.id,
        status: "unverifiable",
        checkerId: checker.id,
        evidence: null,
        reason: `checker crashed: ${error instanceof Error ? error.message : String(error)}`,
        latencyMs: Date.now() - started,
        timestamp: Date.now(),
      };
    }
  }

  private async handleFailure(
    claim: Claim,
    verdict: Verdict,
    context: Record<string, unknown>,
  ): Promise<void> {
    const level = this.policy.levels[claim.consequence];
    const actions = await this.recovery.dispatch(claim, verdict, level.recovery, level.maxRetries);
    for (const action of actions) this.emit("recovery", action);

    const record: FailureRecord = {
      id: randomUUID(),
      claim,
      verdict,
      context,
      recoveryActions: actions,
      resolution: resolutionOf(actions),
      createdAt: Date.now(),
    };
    await this.storage.appendFailureRecord(record);
    this.emit("failure", record);
  }

  async failureRecords(filter?: {agentId?: string; since?: number}): Promise<FailureRecord[]> {
    return this.storage.getFailureRecords(filter);
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}

function resolutionOf(actions: RecoveryAction[]): FailureRecord["resolution"] {
  if (actions.some((a) => a.type !== "escalate" && a.type !== "quarantine" && a.outcome === "recovered")) {
    return "recovered";
  }
  if (actions.some((a) => a.type === "quarantine" && a.outcome === "recovered")) return "quarantined";
  if (actions.some((a) => a.type === "escalate" && a.outcome === "recovered")) return "escalated";
  return "unresolved";
}
