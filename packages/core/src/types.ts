/**
 * The Krett primitive, as types.
 *
 * A Claim is what the agent says it did. A Verdict is what an independent
 * Checker observed. Independence law (AGENTS.md #1): a Checker may never emit
 * `verified` from evidence the agent produced; when independent confirmation is
 * impossible, the verdict is `unverifiable`, never `verified`.
 */

export type ConsequenceLevel = "low" | "medium" | "high" | "critical";

/** What the agent claims to have done, structured enough to check. */
export interface ClaimAction {
  /** e.g. "create", "update", "delete", "send", "transfer" */
  verb: string;
  /** The target system, e.g. "crm", "filesystem", "github", "ledger". */
  system: string;
  /** The target entity within the system, e.g. "contact:123", "/tmp/report.pdf". */
  entity: string;
  /** The state the agent claims now holds, as checkable key/values. */
  expect: Record<string, unknown>;
}

export interface Claim {
  id: string;
  agentId: string;
  runId: string;
  timestamp: number;
  action: ClaimAction;
  /**
   * Whatever the agent offered as proof. Stored for the record, surfaced in
   * escalations, and NEVER used by a checker to reach `verified`.
   */
  evidenceFromAgent?: unknown;
  consequence: ConsequenceLevel;
}

export type VerdictStatus = "verified" | "failed" | "unverifiable";

export interface Verdict {
  claimId: string;
  status: VerdictStatus;
  /** Which checker produced this; "none" when no checker supported the claim. */
  checkerId: string;
  /** What the checker independently observed (its own reads, never the agent's). */
  evidence: unknown;
  /** Required for `failed` and `unverifiable`: the human-readable why. */
  reason?: string;
  latencyMs: number;
  timestamp: number;
}

export type CheckerAccess = "read" | "write";

export interface CheckerContext {
  signal?: AbortSignal;
}

export interface Checker {
  id: string;
  /** Checkers must function with read access alone (AGENTS.md #3). */
  access: CheckerAccess;
  supports(claim: Claim): boolean;
  check(claim: Claim, ctx: CheckerContext): Promise<Verdict>;
}

export type RecoveryType = "retry" | "rollback" | "escalate" | "quarantine";

export interface RecoveryAction {
  type: RecoveryType;
  claimId: string;
  payload?: unknown;
  outcome: "recovered" | "failed" | "skipped";
  detail?: string;
  timestamp: number;
}

/**
 * The company's core asset. Append-only (AGENTS.md #2): storage adapters expose
 * no update or delete for these, and migrations must preserve them.
 */
export interface FailureRecord {
  id: string;
  claim: Claim;
  verdict: Verdict;
  /** Snapshot of whatever context the caller attached at submit time. */
  context: Record<string, unknown>;
  recoveryActions: RecoveryAction[];
  resolution: "recovered" | "escalated" | "quarantined" | "unresolved";
  createdAt: number;
}

export type VerificationTiming = "inline" | "async";

export interface PolicyLevel {
  /**
   * Ordered checker ids to try; the first whose supports() matches runs.
   * Empty means: any registered checker that supports the claim, in
   * registration order.
   */
  checkers: string[];
  timing: VerificationTiming;
  /** The recovery ladder, attempted in order on a `failed` verdict. */
  recovery: RecoveryType[];
  maxRetries: number;
}

export interface Policy {
  levels: Record<ConsequenceLevel, PolicyLevel>;
}

/** Sane zero-config default (AGENTS.md #8): verify everything, escalate loudly. */
export const defaultPolicy: Policy = {
  levels: {
    low: {checkers: [], timing: "async", recovery: ["retry"], maxRetries: 1},
    medium: {checkers: [], timing: "async", recovery: ["retry", "escalate"], maxRetries: 2},
    high: {checkers: [], timing: "inline", recovery: ["retry", "escalate"], maxRetries: 2},
    critical: {
      checkers: [],
      timing: "inline",
      recovery: ["retry", "rollback", "escalate", "quarantine"],
      maxRetries: 3,
    },
  },
};

/**
 * Recovery execution lives in @krett-ai/recover (Phase 3). The engine dispatches
 * through this seam so core stays dependency-free and recovery stays testable.
 */
export interface RecoveryDispatcher {
  dispatch(
    claim: Claim,
    verdict: Verdict,
    ladder: RecoveryType[],
    maxRetries: number,
  ): Promise<RecoveryAction[]>;
}
