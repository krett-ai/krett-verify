/**
 * LedgerChecker: exact money math, real verification through the checker's own
 * balance reader, and the mandatory trio — happy path, agent-lies-caught,
 * unreachable-target-is-unverifiable.
 */
import {describe, expect, it} from "vitest";
import type {Claim} from "@krett-ai/core";
import {LedgerChecker, fromUnits, toUnits} from "../src/index.js";

function claim(expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "transfer", system: "ledger", entity: "transfer:tx-1", expect: expect_},
    consequence: "critical",
  };
}

describe("money math", () => {
  it("parses and formats decimals exactly, without floats", () => {
    expect(toUnits("25.10")).toBe(25_100_000n);
    expect(toUnits("-0.000001")).toBe(-1n);
    expect(toUnits("+3")).toBe(3_000_000n);
    expect(fromUnits(25_100_000n)).toBe("25.1");
    expect(fromUnits(-1n)).toBe("-0.000001");
    expect(() => toUnits("1e5")).toThrow();
    expect(() => toUnits("0.0000001")).toThrow();
  });
});

describe("LedgerChecker", () => {
  it("verifies a real transfer: balances, deltas, and conservation", async () => {
    const balances = new Map([
      ["ops", "1000.00"],
      ["vendor", "1000.00"],
    ]);
    const checker = new LedgerChecker({
      readBalance: async (account) => {
        const value = balances.get(account);
        if (value === undefined) throw new Error(`unknown account ${account}`);
        return value;
      },
    });
    await checker.snapshot(["ops", "vendor"]);
    balances.set("ops", "975.00");
    balances.set("vendor", "1025.00");
    const verdict = await checker.check(
      claim({deltas: {ops: "-25.00", vendor: "25.00"}, balances: {ops: "975.00"}}),
      {},
    );
    expect(verdict.status).toBe("verified");
  });

  it("catches the agent claiming a transfer that never moved money", async () => {
    const checker = new LedgerChecker({readBalance: async () => "1000.00"});
    await checker.snapshot(["ops", "vendor"]);
    const verdict = await checker.check(
      claim({deltas: {ops: "-25.00", vendor: "25.00"}}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("expected delta -25.00, observed 0");
  });

  it("rejects non-conserving deltas even when each account matches", async () => {
    const balances = new Map([["ops", "1000.00"]]);
    const checker = new LedgerChecker({
      readBalance: async (account) => balances.get(account) ?? "0",
    });
    await checker.snapshot(["ops"]);
    balances.set("ops", "975.00");
    const verdict = await checker.check(claim({deltas: {ops: "-25.00"}}), {});
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("do not conserve");
  });

  it("a delta claim without a snapshot is unverifiable, never guessed", async () => {
    const checker = new LedgerChecker({readBalance: async () => "1000.00"});
    const verdict = await checker.check(
      claim({deltas: {ops: "-25.00", vendor: "25.00"}}),
      {},
    );
    expect(verdict.status).toBe("unverifiable");
    expect(verdict.reason).toContain("no snapshot");
  });

  it("an unreachable ledger is unverifiable, not verified and not failed", async () => {
    const checker = new LedgerChecker({
      readBalance: async () => {
        throw new Error("ledger API 503");
      },
    });
    const verdict = await checker.check(claim({balances: {ops: "975.00"}}), {});
    expect(verdict.status).toBe("unverifiable");
    expect(verdict.reason).toContain("503");
  });
});
