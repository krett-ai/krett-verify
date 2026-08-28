/**
 * Every checker's three mandatory tests (AGENTS.md #7):
 * happy path, silent-failure catch (the agent lies, the checker notices),
 * and unreachable system (unverifiable, never verified).
 */
import {describe, expect, it} from "vitest";
import type {Claim} from "@krett/core";
import {
  ChallengeProbeChecker,
  HttpEffectChecker,
  InvariantChecker,
  StateSnapshotChecker,
} from "../src/index.js";

function claim(system: string, entity: string, expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "update", system, entity, expect: expect_},
    evidenceFromAgent: {agentSays: "definitely done"},
    consequence: "high",
  };
}

describe("StateSnapshotChecker", () => {
  const world = new Map<string, Record<string, unknown>>([["contact:1", {stage: "won"}]]);
  const checker = new StateSnapshotChecker({
    systems: ["crm"],
    readState: async (target) => {
      const state = world.get(target);
      if (!state) throw new Error("connection refused");
      return state;
    },
  });

  it("verified when the world matches", async () => {
    const v = await checker.check(claim("crm", "contact:1", {stage: "won"}), {});
    expect(v.status).toBe("verified");
  });

  it("catches the lying agent", async () => {
    const v = await checker.check(claim("crm", "contact:1", {stage: "lost"}), {});
    expect(v.status).toBe("failed");
    expect(v.reason).toContain("expected stage");
  });

  it("unreachable system is unverifiable, never verified", async () => {
    const v = await checker.check(claim("crm", "contact:down", {stage: "won"}), {});
    expect(v.status).toBe("unverifiable");
  });
});

describe("ChallengeProbeChecker", () => {
  const checker = new ChallengeProbeChecker({
    supports: (c) => c.action.system === "ledger",
    probe: async (c) => {
      if (c.action.entity === "account:down") throw new Error("probe route 503");
      return {balance: 100};
    },
  });

  it("verified when the independent path agrees", async () => {
    const v = await checker.check(claim("ledger", "account:1", {balance: 100}), {});
    expect(v.status).toBe("verified");
  });

  it("catches the lying agent via the second path", async () => {
    const v = await checker.check(claim("ledger", "account:1", {balance: 250}), {});
    expect(v.status).toBe("failed");
  });

  it("probe path down is unverifiable", async () => {
    const v = await checker.check(claim("ledger", "account:down", {balance: 100}), {});
    expect(v.status).toBe("unverifiable");
  });
});

describe("InvariantChecker", () => {
  it("verified when every invariant holds", async () => {
    const checker = new InvariantChecker({
      systems: ["ledger"],
      invariants: [{name: "balances-to-zero", holds: async () => true}],
    });
    const v = await checker.check(claim("ledger", "book", {}), {});
    expect(v.status).toBe("verified");
  });

  it("a broken invariant is a failure with its name in the reason", async () => {
    const checker = new InvariantChecker({
      systems: ["ledger"],
      invariants: [
        {name: "balances-to-zero", holds: async () => false},
        {name: "row-count", holds: async () => true},
      ],
    });
    const v = await checker.check(claim("ledger", "book", {}), {});
    expect(v.status).toBe("failed");
    expect(v.reason).toContain("balances-to-zero");
  });

  it("an unevaluable invariant is unverifiable", async () => {
    const checker = new InvariantChecker({
      systems: ["ledger"],
      invariants: [{name: "db-check", holds: async () => { throw new Error("db down"); }}],
    });
    const v = await checker.check(claim("ledger", "book", {}), {});
    expect(v.status).toBe("unverifiable");
  });
});

describe("HttpEffectChecker", () => {
  const okResponse = () => new Response("hello krett", {status: 200});

  it("verified when the fetched resource satisfies the predicate", async () => {
    const checker = new HttpEffectChecker({
      predicate: (r, body) => r.status === 200 && body.includes("krett"),
      fetchFn: async () => okResponse(),
    });
    const v = await checker.check(claim("http", "https://example.com/x", {}), {});
    expect(v.status).toBe("verified");
  });

  it("catches the lie when the resource does not satisfy the predicate", async () => {
    const checker = new HttpEffectChecker({
      predicate: (_r, body) => body.includes("does-not-exist"),
      fetchFn: async () => okResponse(),
    });
    const v = await checker.check(claim("http", "https://example.com/x", {}), {});
    expect(v.status).toBe("failed");
  });

  it("network failure is unverifiable", async () => {
    const checker = new HttpEffectChecker({
      predicate: () => true,
      fetchFn: async () => { throw new Error("ECONNREFUSED"); },
    });
    const v = await checker.check(claim("http", "https://example.com/x", {}), {});
    expect(v.status).toBe("unverifiable");
  });
});
