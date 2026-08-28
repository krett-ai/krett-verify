/**
 * EmailChecker: the provider's records are the truth, not the agent's send
 * call. Mandatory trio plus the Resend provider seam.
 */
import {describe, expect, it} from "vitest";
import type {Claim} from "@krett/core";
import {EmailChecker, resendProvider} from "../src/index.js";

function claim(entity: string, expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "send", system: "email", entity, expect: expect_},
    consequence: "high",
  };
}

describe("EmailChecker", () => {
  it("verifies a delivered email the provider actually has", async () => {
    const checker = new EmailChecker({
      lookup: async (ref) =>
        ref === "msg-1"
          ? {to: "buyer@example.com", subject: "Your receipt", last_event: "delivered"}
          : null,
    });
    const verdict = await checker.check(
      claim("message:msg-1", {to: "buyer@example.com", last_event: "delivered"}),
      {},
    );
    expect(verdict.status).toBe("verified");
  });

  it("catches the agent claiming a send the provider never recorded", async () => {
    const checker = new EmailChecker({lookup: async () => null});
    const verdict = await checker.check(
      claim("message:msg-ghost", {to: "buyer@example.com"}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("not in the provider's records");
  });

  it("catches a bounced email claimed as delivered", async () => {
    const checker = new EmailChecker({
      lookup: async () => ({to: "buyer@example.com", last_event: "bounced"}),
    });
    const verdict = await checker.check(
      claim("message:msg-2", {last_event: "delivered"}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("bounced");
  });

  it("an unreachable provider is unverifiable, never verified", async () => {
    const checker = new EmailChecker({
      lookup: async () => {
        throw new Error("provider 503");
      },
    });
    const verdict = await checker.check(claim("message:msg-1", {to: "x@y.z"}), {});
    expect(verdict.status).toBe("unverifiable");
    expect(verdict.reason).toContain("503");
  });

  it("resendProvider reads by id with the checker's own key", async () => {
    const seen: Array<{url: string; auth: string | undefined}> = [];
    const lookup = resendProvider({
      apiKey: "re_test",
      fetchFn: async (url, init) => {
        seen.push({url, auth: init?.headers?.["authorization"]});
        return url.endsWith("/emails/msg-1")
          ? {status: 200, json: async () => ({last_event: "delivered"})}
          : {status: 404, json: async () => ({})};
      },
    });
    expect(await lookup("msg-1")).toEqual({last_event: "delivered"});
    expect(await lookup("nope")).toBeNull();
    expect(seen[0]?.auth).toBe("Bearer re_test");
  });
});
