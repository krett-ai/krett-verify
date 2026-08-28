/**
 * CLI commands: init writes the quickstart, report summarizes a real corpus,
 * watch streams exactly the new records. All against a real sqlite file.
 */
import {mkdtemp, readFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {describe, expect, it} from "vitest";
import {SqliteStorage} from "@krett/core";
import type {FailureRecord} from "@krett/core";
import {init, report, watch} from "../src/commands.js";

function record(id: string, agentId: string, createdAt: number): FailureRecord {
  return {
    id,
    claim: {
      id: `claim-${id}`,
      agentId,
      runId: "r1",
      timestamp: createdAt,
      action: {verb: "send", system: "email", entity: `message:${id}`, expect: {}},
      consequence: "high",
    },
    verdict: {
      claimId: `claim-${id}`,
      status: "failed",
      checkerId: "email",
      evidence: null,
      reason: "no message in provider records",
      latencyMs: 3,
      timestamp: createdAt,
    },
    context: {},
    recoveryActions: [],
    resolution: "escalated",
    createdAt,
  };
}

async function seededDb(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "krett-cli-"));
  const path = join(dir, "krett.db");
  const storage = new SqliteStorage(path);
  await storage.appendFailureRecord(record("1", "mailer", 1000));
  await storage.appendFailureRecord(record("2", "mailer", 2000));
  await storage.appendFailureRecord(record("3", "biller", 3000));
  await storage.close();
  return path;
}

function collector(): {lines: string[]; print: (line: string) => void} {
  const lines: string[] = [];
  return {lines, print: (line) => lines.push(line)};
}

describe("krett init", () => {
  it("writes a runnable quickstart and refuses to overwrite", async () => {
    const dir = await mkdtemp(join(tmpdir(), "krett-init-"));
    const path = join(dir, "krett-quickstart.mjs");
    const {lines, print} = collector();
    expect(await init(print, path)).toBe(0);
    const content = await readFile(path, "utf8");
    expect(content).toContain("FilesystemChecker");
    expect(content).toContain("k.verify");
    expect(await init(print, path)).toBe(1);
    expect(lines.join("\n")).toContain("refusing to overwrite");
  });
});

describe("krett report", () => {
  it("summarizes the corpus and filters by agent", async () => {
    const path = await seededDb();
    const {lines, print} = collector();
    expect(await report(print, path)).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("failures caught: 3");
    expect(text).toContain("escalated");
    expect(text).toContain("mailer");

    const json = collector();
    expect(await report(json.print, path, {json: true, agentId: "mailer"})).toBe(0);
    const summary = JSON.parse(json.lines.join("\n"));
    expect(summary.failures).toBe(2);
    expect(summary.agents).toEqual({mailer: 2});
  });

  it("a missing database is an error, not an empty success", async () => {
    const {lines, print} = collector();
    expect(await report(print, "/nowhere/krett.db")).toBe(1);
    expect(lines.join("\n")).toContain("no database");
  });
});

describe("krett watch", () => {
  it("streams only records newer than what it has seen", async () => {
    const path = await seededDb();
    const {lines, print} = collector();
    expect(await watch(print, path, {once: true})).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("mailer send message:1");
    expect(text).toContain("biller send message:3");
    expect(lines.filter((l) => l.includes("[escalated]"))).toHaveLength(3);
  });
});
