/**
 * BrowserChecker: the page the checker renders itself is the truth, not the
 * screenshot the agent hands over. Mandatory trio plus regex and absence.
 */
import {describe, expect, it} from "vitest";
import type {Claim} from "@krett-ai/core";
import {BrowserChecker} from "../src/index.js";

function claim(url: string, expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "publish", system: "browser", entity: `url:${url}`, expect: expect_},
    consequence: "high",
  };
}

describe("BrowserChecker", () => {
  it("verifies content the page really shows, via its own renderer", async () => {
    const rendered: string[] = [];
    const checker = new BrowserChecker({
      render: async (url) => {
        rendered.push(url);
        return "<html><h1>Launch day</h1><p>Krett verifies agents.</p></html>";
      },
    });
    const verdict = await checker.check(
      claim("https://krett.ai", {
        contains: ["Launch day", "verifies agents"],
        notContains: "404",
        matches: "<h1>[^<]+</h1>",
      }),
      {},
    );
    expect(verdict.status).toBe("verified");
    expect(rendered).toEqual(["https://krett.ai"]);
  });

  it("catches the agent claiming a post that never appeared", async () => {
    const checker = new BrowserChecker({
      render: async () => "<html><p>Nothing here yet.</p></html>",
    });
    const verdict = await checker.check(
      claim("https://example.com/posts", {contains: "My new post"}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("does not contain");
  });

  it("catches content the agent claims it removed but is still live", async () => {
    const checker = new BrowserChecker({
      render: async () => "<html><p>OLD PRICE $9</p></html>",
    });
    const verdict = await checker.check(
      claim("https://example.com/pricing", {notContains: "OLD PRICE"}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("still contains");
  });

  it("an unreachable page is unverifiable, never verified", async () => {
    const checker = new BrowserChecker({
      render: async () => {
        throw new Error("page answered 503");
      },
    });
    const verdict = await checker.check(
      claim("https://example.com", {contains: "anything"}),
      {},
    );
    expect(verdict.status).toBe("unverifiable");
    expect(verdict.reason).toContain("503");
  });

  it("a claim with no expectations is unverifiable, not waved through", async () => {
    const checker = new BrowserChecker({render: async () => "<html></html>"});
    const verdict = await checker.check(claim("https://example.com", {}), {});
    expect(verdict.status).toBe("unverifiable");
  });
});
