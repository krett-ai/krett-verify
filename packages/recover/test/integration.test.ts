/**
 * Engine + LadderRecovery, end to end: an agent lies, an independent checker
 * catches it, the ladder runs, and the FailureRecord tells the whole story.
 */
import {describe, expect, it} from "vitest";
import type {Checker, Claim} from "@krett-ai/core";
import {KrettEngine} from "@krett-ai/core";
import {LadderRecovery} from "../src/index.js";

function claim(id: string): Claim {
  return {
    id,
    agentId: "mailer-agent",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "send", system: "world", entity: "message:42", expect: {sent: true}},
    consequence: "critical",
  };
}

describe("engine with LadderRecovery", () => {
  it("records a failed claim as recovered once the retry re-verifies", async () => {
    // The world: the send never happened until the retry actually does it.
    const world = {sent: false};
    const checker: Checker = {
      id: "world",
      access: "read",
      supports: (c) => c.action.system === "world",
      check: async (c) => ({
        claimId: c.id,
        status: world.sent ? "verified" : "failed",
        checkerId: "world",
        evidence: {sent: world.sent},
        latencyMs: 0,
        timestamp: Date.now(),
      }),
    };
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {
          world.sent = true;
        },
        verify: async (c) => checker.check(c, {}),
      },
    });
    const engine = new KrettEngine({checkers: [checker], recovery});

    const verdict = await engine.submit(claim("c-lied"));
    expect(verdict.status).toBe("failed");

    const records = await engine.failureRecords({agentId: "mailer-agent"});
    expect(records).toHaveLength(1);
    expect(records[0]?.resolution).toBe("recovered");
    expect(records[0]?.recoveryActions.map((a) => [a.type, a.outcome])).toEqual([
      ["retry", "recovered"],
    ]);
    await engine.close();
  });

  it("quarantines through the full ladder when nothing can be fixed", async () => {
    const checker: Checker = {
      id: "world",
      access: "read",
      supports: (c) => c.action.system === "world",
      check: async (c) => ({
        claimId: c.id,
        status: "failed",
        checkerId: "world",
        evidence: null,
        reason: "the claimed effect is absent",
        latencyMs: 0,
        timestamp: Date.now(),
      }),
    };
    const recovery = new LadderRecovery({
      retry: {
        execute: async () => {},
        verify: async (c) => checker.check(c, {}),
      },
    });
    const engine = new KrettEngine({checkers: [checker], recovery});

    await engine.submit(claim("c-hopeless"));
    const records = await engine.failureRecords();
    expect(records[0]?.resolution).toBe("quarantined");
    expect(recovery.isQuarantined("mailer-agent")).toBe(true);
    await engine.close();
  });
});
