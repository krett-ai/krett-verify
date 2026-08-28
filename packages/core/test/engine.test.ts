/**
 * Phase 1 acceptance: the three verdict paths, recovery dispatch on `failed`,
 * and the engine's one-way safety property: nothing but a checker's own
 * independent confirmation ever produces `verified`.
 */
import {describe, expect, it} from "vitest";
import {
  KrettEngine,
  MemoryStorage,
  defaultPolicy,
  type Checker,
  type Claim,
  type RecoveryAction,
  type RecoveryDispatcher,
  type Verdict,
} from "../src/index.js";

/** A mock system whose ground truth we control per-entity. */
function mockChecker(truth: Map<string, Record<string, unknown> | "unreachable">): Checker {
  return {
    id: "mock",
    access: "read",
    supports: (claim) => claim.action.system === "mock",
    async check(claim): Promise<Verdict> {
      const started = Date.now();
      const state = truth.get(claim.action.entity);
      if (state === "unreachable" || state === undefined) {
        return {
          claimId: claim.id,
          status: "unverifiable",
          checkerId: "mock",
          evidence: null,
          reason: "target system unreachable",
          latencyMs: Date.now() - started,
          timestamp: Date.now(),
        };
      }
      const matches = Object.entries(claim.action.expect).every(
        ([k, v]) => JSON.stringify(state[k]) === JSON.stringify(v),
      );
      return {
        claimId: claim.id,
        status: matches ? "verified" : "failed",
        checkerId: "mock",
        evidence: state,
        ...(matches ? {} : {reason: "observed state does not match the claim"}),
        latencyMs: Date.now() - started,
        timestamp: Date.now(),
      };
    },
  };
}

function claim(entity: string, expect_: Record<string, unknown>, consequence: Claim["consequence"] = "high"): Claim {
  return {
    id: `claim-${entity}-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "agent-1",
    runId: "run-1",
    timestamp: Date.now(),
    action: {verb: "update", system: "mock", entity, expect: expect_},
    evidenceFromAgent: {note: "agent says it worked"},
    consequence,
  };
}

describe("the three verdict paths", () => {
  const truth = new Map<string, Record<string, unknown> | "unreachable">([
    ["record:confirmed", {stage: "won"}],
    ["record:lied", {stage: "lost"}],
    ["record:down", "unreachable"],
  ]);
  const engine = new KrettEngine({checkers: [mockChecker(truth)]});

  it("verified: the world matches the claim", async () => {
    const v = await engine.submit(claim("record:confirmed", {stage: "won"}));
    expect(v.status).toBe("verified");
    expect(v.checkerId).toBe("mock");
  });

  it("failed: the agent reported success and the world disagrees", async () => {
    const v = await engine.submit(claim("record:lied", {stage: "won"}));
    expect(v.status).toBe("failed");
    expect(v.reason).toContain("does not match");
  });

  it("unverifiable: the system cannot be reached, never verified", async () => {
    const v = await engine.submit(claim("record:down", {stage: "won"}));
    expect(v.status).toBe("unverifiable");
  });

  it("unverifiable: no checker supports the claim", async () => {
    const bare = new KrettEngine({checkers: []});
    const v = await bare.submit(claim("record:confirmed", {stage: "won"}));
    expect(v.status).toBe("unverifiable");
    expect(v.checkerId).toBe("none");
  });

  it("unverifiable: a crashing checker proves nothing", async () => {
    const crasher: Checker = {
      id: "crasher",
      access: "read",
      supports: () => true,
      check: async () => {
        throw new Error("boom");
      },
    };
    const engine2 = new KrettEngine({checkers: [crasher]});
    const v = await engine2.submit(claim("anything", {x: 1}));
    expect(v.status).toBe("unverifiable");
    expect(v.reason).toContain("boom");
  });
});

describe("failure handling", () => {
  it("a failed verdict dispatches the policy ladder and appends a FailureRecord", async () => {
    const dispatched: {ladder: string[]; maxRetries: number}[] = [];
    const recovery: RecoveryDispatcher = {
      async dispatch(_c, _v, ladder, maxRetries): Promise<RecoveryAction[]> {
        dispatched.push({ladder: [...ladder], maxRetries});
        return [
          {type: "retry", claimId: _c.id, outcome: "failed", timestamp: Date.now()},
          {type: "escalate", claimId: _c.id, outcome: "recovered", timestamp: Date.now()},
        ];
      },
    };
    const truth = new Map<string, Record<string, unknown> | "unreachable">([
      ["record:lied", {stage: "lost"}],
    ]);
    const storage = new MemoryStorage();
    const engine = new KrettEngine({checkers: [mockChecker(truth)], recovery, storage});

    const events: string[] = [];
    engine.on("failure", () => events.push("failure"));
    engine.on("recovery", () => events.push("recovery"));

    await engine.submit(claim("record:lied", {stage: "won"}, "critical"), {
      context: {ticket: "T-99"},
    });

    // The critical ladder from the default policy reached the dispatcher intact.
    expect(dispatched).toEqual([
      {ladder: defaultPolicy.levels.critical.recovery, maxRetries: 3},
    ]);
    const records = await engine.failureRecords({agentId: "agent-1"});
    expect(records).toHaveLength(1);
    expect(records[0]!.resolution).toBe("escalated");
    expect(records[0]!.context).toEqual({ticket: "T-99"});
    expect(records[0]!.recoveryActions).toHaveLength(2);
    expect(events).toContain("failure");
    expect(events).toContain("recovery");
  });

  it("verified claims append nothing to the failure corpus", async () => {
    const truth = new Map<string, Record<string, unknown> | "unreachable">([
      ["record:fine", {ok: true}],
    ]);
    const engine = new KrettEngine({checkers: [mockChecker(truth)]});
    await engine.submit(claim("record:fine", {ok: true}));
    expect(await engine.failureRecords()).toHaveLength(0);
  });
});
