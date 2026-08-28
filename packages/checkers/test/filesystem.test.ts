/** FilesystemChecker: happy path, agent-lies-caught, unreachable. */
import {describe, expect, it} from "vitest";
import {mkdtempSync, writeFileSync, chmodSync, mkdirSync} from "node:fs";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Claim} from "@krett/core";
import {FilesystemChecker} from "../src/index.js";

const dir = mkdtempSync(join(tmpdir(), "krett-fs-"));
const filePath = join(dir, "report.txt");
writeFileSync(filePath, "quarterly numbers: fine");
const sha = createHash("sha256").update("quarterly numbers: fine").digest("hex");

function claim(entity: string, expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "create", system: "filesystem", entity, expect: expect_},
    consequence: "medium",
  };
}

const checker = new FilesystemChecker();

describe("FilesystemChecker", () => {
  it("verifies a real file with matching hash and content", async () => {
    const v = await checker.check(
      claim(filePath, {exists: true, sha256: sha, contains: "quarterly", minBytes: 10}),
      {},
    );
    expect(v.status).toBe("verified");
  });

  it("catches the agent claiming a file it never wrote", async () => {
    const v = await checker.check(claim(join(dir, "ghost.txt"), {exists: true}), {});
    expect(v.status).toBe("failed");
    expect(v.reason).toContain("exists=false");
  });

  it("catches wrong content behind a right-looking file", async () => {
    const v = await checker.check(claim(filePath, {exists: true, contains: "totally-absent"}), {});
    expect(v.status).toBe("failed");
  });

  it("verifies deletion claims", async () => {
    const v = await checker.check(claim(join(dir, "gone.txt"), {exists: false}), {});
    expect(v.status).toBe("verified");
  });

  it("permission-denied is unverifiable, never verified", async () => {
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "secret.txt"), "x");
    chmodSync(locked, 0o000);
    try {
      const v = await checker.check(claim(join(locked, "secret.txt"), {exists: true, contains: "x"}), {});
      expect(v.status).toBe("unverifiable");
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});
