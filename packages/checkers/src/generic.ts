/**
 * Generic checkers: work against any system the caller can independently read.
 *
 * Independence law (AGENTS.md #1): every read path here is caller-provided and
 * must be independent of the agent (different credential, different route).
 * These checkers never look at claim.evidenceFromAgent. When the independent
 * path cannot answer, the verdict is `unverifiable`, never `verified`.
 */
import type {Checker, CheckerContext, Claim, Verdict} from "@krett/core";

function verdict(
  claim: Claim,
  checkerId: string,
  started: number,
  status: Verdict["status"],
  evidence: unknown,
  reason?: string,
): Verdict {
  return {
    claimId: claim.id,
    status,
    checkerId,
    evidence,
    ...(reason ? {reason} : {}),
    latencyMs: Date.now() - started,
    timestamp: Date.now(),
  };
}

function matches(observed: Record<string, unknown>, expected: Record<string, unknown>): string | null {
  for (const [key, want] of Object.entries(expected)) {
    const got = observed[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      return `expected ${key}=${JSON.stringify(want)}, observed ${JSON.stringify(got)}`;
    }
  }
  return null;
}

/**
 * StateSnapshotChecker: re-reads the target after the action through a
 * caller-registered independent reader and diffs against the claim's expected
 * state. Optionally snapshot() before the action for before/after evidence.
 */
export class StateSnapshotChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly readState: (target: string) => Promise<Record<string, unknown>>;
  private readonly systems: string[];
  private readonly before = new Map<string, Record<string, unknown>>();

  constructor(options: {
    id?: string;
    systems: string[];
    readState: (target: string) => Promise<Record<string, unknown>>;
  }) {
    this.id = options.id ?? "state-snapshot";
    this.systems = options.systems;
    this.readState = options.readState;
  }

  /** Optional: capture pre-action state so failed verdicts carry a diff. */
  async snapshot(target: string): Promise<void> {
    this.before.set(target, await this.readState(target));
  }

  supports(claim: Claim): boolean {
    return this.systems.includes(claim.action.system);
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    let observed: Record<string, unknown>;
    try {
      observed = await this.readState(claim.action.entity);
    } catch (error) {
      return verdict(claim, this.id, started, "unverifiable", null,
        `independent read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const evidence = {observed, before: this.before.get(claim.action.entity) ?? null};
    const mismatch = matches(observed, claim.action.expect);
    return mismatch
      ? verdict(claim, this.id, started, "failed", evidence, mismatch)
      : verdict(claim, this.id, started, "verified", evidence);
  }
}

/**
 * ChallengeProbeChecker: re-queries the target through a caller-provided path
 * the agent did not use (different API route, different credential, raw DB
 * read) and compares against the claim.
 */
export class ChallengeProbeChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly probe: (claim: Claim) => Promise<Record<string, unknown>>;
  private readonly supportsFn: (claim: Claim) => boolean;

  constructor(options: {
    id?: string;
    supports: (claim: Claim) => boolean;
    probe: (claim: Claim) => Promise<Record<string, unknown>>;
  }) {
    this.id = options.id ?? "challenge-probe";
    this.supportsFn = options.supports;
    this.probe = options.probe;
  }

  supports(claim: Claim): boolean {
    return this.supportsFn(claim);
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    let observed: Record<string, unknown>;
    try {
      observed = await this.probe(claim);
    } catch (error) {
      return verdict(claim, this.id, started, "unverifiable", null,
        `probe path failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const mismatch = matches(observed, claim.action.expect);
    return mismatch
      ? verdict(claim, this.id, started, "failed", {observed}, mismatch)
      : verdict(claim, this.id, started, "verified", {observed});
  }
}

export interface Invariant {
  name: string;
  /** Must return true after the action for the claim to be verifiable as sound. */
  holds(): Promise<boolean>;
}

/**
 * InvariantChecker: caller-declared invariants ("ledger balances to zero",
 * "row count changed by exactly one") evaluated after the action. All must
 * hold for `verified`; any false invariant is a `failed`; any crash is
 * `unverifiable`.
 */
export class InvariantChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly invariants: Invariant[];
  private readonly systems: string[];

  constructor(options: {id?: string; systems: string[]; invariants: Invariant[]}) {
    this.id = options.id ?? "invariant";
    this.systems = options.systems;
    this.invariants = options.invariants;
  }

  supports(claim: Claim): boolean {
    return this.systems.includes(claim.action.system);
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const results: Record<string, boolean> = {};
    for (const invariant of this.invariants) {
      try {
        results[invariant.name] = await invariant.holds();
      } catch (error) {
        return verdict(claim, this.id, started, "unverifiable", {results},
          `invariant "${invariant.name}" could not be evaluated: ${
            error instanceof Error ? error.message : String(error)}`);
      }
    }
    const broken = Object.entries(results).filter(([, ok]) => !ok).map(([name]) => name);
    return broken.length > 0
      ? verdict(claim, this.id, started, "failed", {results}, `invariants violated: ${broken.join(", ")}`)
      : verdict(claim, this.id, started, "verified", {results});
  }
}

/**
 * HttpEffectChecker: for claims of the form "the resource at URL should now
 * satisfy predicate P". Fetches through the checker's own client (never the
 * agent's session) and evaluates.
 */
export class HttpEffectChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly predicate: (response: Response, body: string, claim: Claim) => Promise<boolean> | boolean;
  private readonly fetchFn: typeof fetch;

  constructor(options: {
    id?: string;
    predicate: (response: Response, body: string, claim: Claim) => Promise<boolean> | boolean;
    fetchFn?: typeof fetch;
  }) {
    this.id = options.id ?? "http-effect";
    this.predicate = options.predicate;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  supports(claim: Claim): boolean {
    return claim.action.system === "http" && /^https?:\/\//.test(claim.action.entity);
  }

  async check(claim: Claim, ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    let response: Response;
    let body: string;
    try {
      response = await this.fetchFn(claim.action.entity, ctx.signal ? {signal: ctx.signal} : {});
      body = await response.text();
    } catch (error) {
      return verdict(claim, this.id, started, "unverifiable", null,
        `fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const satisfied = await this.predicate(response, body, claim);
    const evidence = {status: response.status, bodyPreview: body.slice(0, 500)};
    return satisfied
      ? verdict(claim, this.id, started, "verified", evidence)
      : verdict(claim, this.id, started, "failed", evidence, "predicate not satisfied by observed resource");
  }
}
