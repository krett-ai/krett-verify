/**
 * Ledger checker: the finance-ops wedge. Verifies money-movement claims
 * against balances read through the checker's own path — never the agent's
 * client, never the agent's report.
 *
 * Money law: amounts are compared as scaled integers (string decimals parsed
 * to bigint at a fixed scale). Floats never touch a comparison.
 *
 * Claim conventions (system: "ledger"):
 *   verb "transfer" | "adjust" | "reconcile"
 *   entity: a caller-meaningful reference ("transfer:tx-91", "book:main")
 *   expect.deltas:   { accountId: "-25.00", accountId2: "+25.00" }  — per-account
 *                    change since snapshot(); must also sum to zero unless
 *                    options.requireConservation === false.
 *   expect.balances: { accountId: "975.00" }                        — absolute
 * Either or both may be supplied; all supplied keys must hold.
 *
 * Use snapshot(accounts) before the action to enable delta verification; a
 * delta claim without a snapshot is `unverifiable`, never guessed.
 */
import type {Checker, CheckerContext, Claim, Verdict} from "@krett-ai/core";

const SCALE = 6; // micro-units: enough for money, exact for comparisons

export function toUnits(value: string | number): bigint {
  const s = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(s);
  if (!match) throw new Error(`not a decimal amount: "${s}"`);
  const sign = match[1] ?? "";
  const whole = match[2] ?? "0";
  const frac = match[3] ?? "";
  if (frac.length > SCALE) throw new Error(`more than ${SCALE} decimal places: "${s}"`);
  const units = BigInt(whole) * 10n ** BigInt(SCALE) + BigInt(frac.padEnd(SCALE, "0") || "0");
  return sign === "-" ? -units : units;
}

export class LedgerChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly readBalance: (accountId: string) => Promise<string | number>;
  private readonly requireConservation: boolean;
  private readonly before = new Map<string, bigint>();

  constructor(options: {
    id?: string;
    readBalance: (accountId: string) => Promise<string | number>;
    requireConservation?: boolean;
  }) {
    this.id = options.id ?? "ledger";
    this.readBalance = options.readBalance;
    this.requireConservation = options.requireConservation ?? true;
  }

  /** Capture pre-action balances for the accounts a delta claim will name. */
  async snapshot(accountIds: string[]): Promise<void> {
    for (const id of accountIds) {
      this.before.set(id, toUnits(await this.readBalance(id)));
    }
  }

  supports(claim: Claim): boolean {
    return claim.action.system === "ledger";
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const expect = claim.action.expect as {
      deltas?: Record<string, string>;
      balances?: Record<string, string>;
    };
    if (!expect.deltas && !expect.balances) {
      return this.verdict(claim, started, "unverifiable", null,
        "ledger claims must state expect.deltas and/or expect.balances");
    }

    try {
      const evidence: Record<string, unknown> = {};
      const problem =
        (await this.checkBalances(expect.balances, evidence)) ??
        (await this.checkDeltas(expect.deltas, evidence));
      return problem
        ? this.verdict(claim, started, "failed", evidence, problem)
        : this.verdict(claim, started, "verified", evidence);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.verdict(claim, started, "unverifiable", null, message);
    }
  }

  private async checkBalances(
    balances: Record<string, string> | undefined,
    evidence: Record<string, unknown>,
  ): Promise<string | null> {
    if (!balances) return null;
    for (const [account, want] of Object.entries(balances)) {
      const observed = toUnits(await this.readBalance(account));
      evidence[`balance:${account}`] = observed.toString();
      if (observed !== toUnits(want)) {
        return `account ${account}: expected balance ${want}, observed ${fromUnits(observed)}`;
      }
    }
    return null;
  }

  private async checkDeltas(
    deltas: Record<string, string> | undefined,
    evidence: Record<string, unknown>,
  ): Promise<string | null> {
    if (!deltas) return null;
    let sum = 0n;
    for (const [account, want] of Object.entries(deltas)) {
      const prior = this.before.get(account);
      if (prior === undefined) {
        throw new Error(`no snapshot for account ${account}; call snapshot() before the action`);
      }
      const now = toUnits(await this.readBalance(account));
      const observedDelta = now - prior;
      evidence[`delta:${account}`] = fromUnits(observedDelta);
      const wantUnits = toUnits(want);
      sum += wantUnits;
      if (observedDelta !== wantUnits) {
        return `account ${account}: expected delta ${want}, observed ${fromUnits(observedDelta)}`;
      }
    }
    if (this.requireConservation && sum !== 0n) {
      return `claimed deltas do not conserve: sum is ${fromUnits(sum)}, expected 0`;
    }
    return null;
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

export function fromUnits(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / 10n ** BigInt(SCALE);
  const frac = (abs % 10n ** BigInt(SCALE)).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}
