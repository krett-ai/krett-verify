/**
 * GithubChecker: verified against a fake GitHub API the checker reads itself.
 * Mandatory trio: happy path, agent-lies-caught, unreachable is unverifiable.
 */
import {describe, expect, it} from "vitest";
import type {Claim} from "@krett/core";
import {GithubChecker} from "../src/index.js";

function claim(entity: string, expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "open", system: "github", entity, expect: expect_},
    consequence: "high",
  };
}

/** A fake API: path -> resource, missing paths 404. */
function fakeApi(resources: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchFn = async (url: string) => {
    const path = url.replace("https://api.github.com", "");
    calls.push(path);
    const body = resources[path];
    return {
      status: body === undefined ? 404 : 200,
      json: async () => body,
    };
  };
  return {fetchFn, calls};
}

describe("GithubChecker", () => {
  it("verifies a PR the agent really opened, reading the API itself", async () => {
    const {fetchFn, calls} = fakeApi({
      "/repos/krett-ai/krett-verify/pulls/12": {
        state: "open",
        merged: false,
        head: {ref: "fix-ci"},
      },
    });
    const checker = new GithubChecker({fetchFn});
    const verdict = await checker.check(
      claim("pr:krett-ai/krett-verify#12", {state: "open", "head.ref": "fix-ci"}),
      {},
    );
    expect(verdict.status).toBe("verified");
    expect(calls).toEqual(["/repos/krett-ai/krett-verify/pulls/12"]);
  });

  it("catches the agent claiming a merge that never happened", async () => {
    const {fetchFn} = fakeApi({
      "/repos/krett-ai/krett-verify/pulls/12": {state: "open", merged: false},
    });
    const checker = new GithubChecker({fetchFn});
    const verdict = await checker.check(
      claim("pr:krett-ai/krett-verify#12", {merged: true}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("merged");
  });

  it("catches a PR that does not exist at all", async () => {
    const {fetchFn} = fakeApi({});
    const checker = new GithubChecker({fetchFn});
    const verdict = await checker.check(
      claim("pr:krett-ai/krett-verify#999", {state: "open"}),
      {},
    );
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("does not exist");
  });

  it("verifies deletion claims through $exists: false", async () => {
    const {fetchFn} = fakeApi({
      "/repos/krett-ai/krett-verify/branches/kept": {name: "kept"},
    });
    const checker = new GithubChecker({fetchFn});
    const gone = await checker.check(
      claim("branch:krett-ai/krett-verify@stale", {$exists: false}),
      {},
    );
    expect(gone.status).toBe("verified");
    const lied = await checker.check(
      claim("branch:krett-ai/krett-verify@kept", {$exists: false}),
      {},
    );
    expect(lied.status).toBe("failed");
  });

  it("an unreachable API is unverifiable, never verified", async () => {
    const checker = new GithubChecker({
      fetchFn: async () => {
        throw new Error("network down");
      },
    });
    const verdict = await checker.check(
      claim("pr:krett-ai/krett-verify#12", {state: "open"}),
      {},
    );
    expect(verdict.status).toBe("unverifiable");
    expect(verdict.reason).toContain("network down");
  });

  it("an auth failure is unverifiable, not a failed agent", async () => {
    const checker = new GithubChecker({
      fetchFn: async () => ({status: 401, json: async () => ({})}),
    });
    const verdict = await checker.check(
      claim("pr:krett-ai/krett-verify#12", {state: "open"}),
      {},
    );
    expect(verdict.status).toBe("unverifiable");
    expect(verdict.reason).toContain("401");
  });
});
