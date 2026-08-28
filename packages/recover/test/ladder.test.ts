/**
 * LadderRecovery: the four strategies, each proven the hard way — retry only
 * recovered when re-verified, rollback only when verified, unverifiable never
 * counts, and the quarantine boundary is exact.
 */
import {describe, expect, it} from "vitest";
import type {Claim, Verdict} from "@krett/core";
import {LadderRecovery} from "../src/index.js";

function claim(agentId = "a1"): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId,
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "send", system: "test", entity: "thing:1", expect: {}},
    consequence: "critical",
  };
}

function verdict(status: Verdict["status"], claimId = "c"): Verdict {
  return {claimId, status, checkerId: "t", evidence: null, latencyMs: 0, timestamp: Date.now()};
}

const FULL_LADDER = ["retry", "rollback", "escalate", "quarantine"] as const;

describe("LadderRecovery", () => {
  it("retry recovers only when the re-check verifies, and stops the ladder", async () => {
    let executions = 0;
    let escalated = false;
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {
          executions++;
        },
        // First re-check still failed; second proves the world is right.
        verify: async () => verdict(executions >= 2 ? "verified" : "failed"),
      },
      escalate: async () => {
        escalated = true;
      },
    });
    const actions = await recovery.dispatch(claim(), verdict("failed"), [...FULL_LADDER], 3);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({type: "retry", outcome: "recovered"});
    expect(actions[0]?.detail).toContain("attempt 2");
    expect(executions).toBe(2);
    expect(escalated).toBe(false);
  });

  it("a retry whose re-check stays failed falls through to escalation", async () => {
    let executions = 0;
    let escalated = false;
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {
          executions++;
        },
        verify: async () => verdict("failed"),
      },
      escalate: async () => {
        escalated = true;
      },
    });
    const actions = await recovery.dispatch(claim(), verdict("failed"), ["retry", "escalate"], 2);
    expect(executions).toBe(2);
    expect(actions.map((a) => [a.type, a.outcome])).toEqual([
      ["retry", "failed"],
      ["escalate", "recovered"],
    ]);
    expect(escalated).toBe(true);
  });

  it("an unverifiable re-check never counts as recovered", async () => {
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {},
        verify: async () => verdict("unverifiable"),
      },
    });
    const actions = await recovery.dispatch(claim(), verdict("failed"), ["retry"], 2);
    expect(actions[0]).toMatchObject({type: "retry", outcome: "failed"});
    expect(actions[0]?.detail).toContain("unverifiable");
  });

  it("rollback recovers only when its verification confirms the undo", async () => {
    let rolledBack = false;
    const recovery = new LadderRecovery({
      rollback: {
        execute: async () => {
          rolledBack = true;
        },
        verify: async () => verdict(rolledBack ? "verified" : "failed"),
      },
    });
    const actions = await recovery.dispatch(claim(), verdict("failed"), ["rollback"], 1);
    expect(actions[0]).toMatchObject({type: "rollback", outcome: "recovered"});

    const broken = new LadderRecovery({
      rollback: {
        execute: async () => {},
        verify: async () => verdict("failed"),
      },
    });
    const failed = await broken.dispatch(claim(), verdict("failed"), ["rollback"], 1);
    expect(failed[0]).toMatchObject({type: "rollback", outcome: "failed"});
  });

  it("a crashing handler is a failed step, not a crashed dispatcher", async () => {
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {
          throw new Error("action exploded");
        },
        verify: async () => verdict("verified"),
      },
    });
    const actions = await recovery.dispatch(claim(), verdict("failed"), ["retry"], 1);
    expect(actions[0]).toMatchObject({type: "retry", outcome: "failed"});
    expect(actions[0]?.detail).toContain("action exploded");
  });

  it("quarantine boundary is exact: that agent only, effective immediately", async () => {
    let executions = 0;
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {
          executions++;
        },
        verify: async () => verdict("failed"),
      },
      rollback: {
        execute: async () => {},
        verify: async () => verdict("failed"),
      },
    });

    // Everything fails, no escalation channel: the ladder ends in quarantine.
    const first = await recovery.dispatch(claim("agent-bad"), verdict("failed"), [...FULL_LADDER], 1);
    expect(first.map((a) => [a.type, a.outcome])).toEqual([
      ["retry", "failed"],
      ["rollback", "failed"],
      ["escalate", "skipped"],
      ["quarantine", "recovered"],
    ]);
    expect(recovery.isQuarantined("agent-bad")).toBe(true);
    expect(recovery.isQuarantined("agent-good")).toBe(false);

    // Quarantined agent gets no further side effects — straight back to quarantine.
    const before = executions;
    const second = await recovery.dispatch(claim("agent-bad"), verdict("failed"), [...FULL_LADDER], 3);
    expect(executions).toBe(before);
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({type: "quarantine", outcome: "recovered"});

    // Another agent is untouched by the boundary.
    await recovery.dispatch(claim("agent-good"), verdict("failed"), ["retry"], 1);
    expect(executions).toBe(before + 1);

    // Lifting is an explicit human decision.
    recovery.lift("agent-bad");
    expect(recovery.isQuarantined("agent-bad")).toBe(false);
  });

  it("a failed external quarantine hook still holds the local boundary", async () => {
    const recovery = new LadderRecovery({
      quarantine: async () => {
        throw new Error("revoke API down");
      },
    });
    const actions = await recovery.dispatch(claim("agent-x"), verdict("failed"), ["quarantine"], 1);
    expect(actions[0]).toMatchObject({type: "quarantine", outcome: "recovered"});
    expect(actions[0]?.detail).toContain("local boundary still holds");
    expect(recovery.isQuarantined("agent-x")).toBe(true);
  });
});
