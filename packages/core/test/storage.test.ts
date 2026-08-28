/**
 * Storage adapters honor the same contract, including the append-only law:
 * the interface offers no update and no delete for failure records, and what
 * goes in comes back out byte-identical.
 */
import {afterAll, describe, expect, it} from "vitest";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import type {Claim, FailureRecord, StorageAdapter, Verdict} from "../src/index.js";
import {MemoryStorage, SqliteStorage, PostgresStorage} from "../src/index.js";

const claim: Claim = {
  id: "c-1",
  agentId: "agent-9",
  runId: "run-1",
  timestamp: 1000,
  action: {verb: "update", system: "crm", entity: "contact:1", expect: {stage: "won"}},
  consequence: "high",
};
const verdict: Verdict = {
  claimId: "c-1",
  status: "failed",
  checkerId: "crm",
  evidence: {stage: "lost"},
  reason: "state mismatch",
  latencyMs: 12,
  timestamp: 1001,
};
const record: FailureRecord = {
  id: "f-1",
  claim,
  verdict,
  context: {note: "test"},
  recoveryActions: [{type: "escalate", claimId: "c-1", outcome: "recovered", timestamp: 1002}],
  resolution: "escalated",
  createdAt: 1002,
};

function contract(name: string, make: () => StorageAdapter, enabled = true) {
  describe.skipIf(!enabled)(name, () => {
    const store = make();
    afterAll(() => store.close());

    it("round-trips claim, verdicts, and failure records", async () => {
      await store.saveClaim(claim);
      await store.saveVerdict(verdict);
      await store.appendFailureRecord(record);
      expect(await store.getClaim("c-1")).toEqual(claim);
      expect(await store.getVerdicts("c-1")).toEqual([verdict]);
      const failures = await store.getFailureRecords({agentId: "agent-9"});
      expect(failures).toEqual([record]);
      expect(await store.getFailureRecords({agentId: "someone-else"})).toEqual([]);
      expect(await store.getFailureRecords({since: 5000})).toEqual([]);
    });

    it("exposes no mutation surface for failure records", () => {
      const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).join(",");
      expect(surface).not.toMatch(/delete|update|remove/i);
    });
  });
}

contract("MemoryStorage", () => new MemoryStorage());
contract("SqliteStorage", () => new SqliteStorage(join(mkdtempSync(join(tmpdir(), "krett-")), "t.db")));
contract(
  "PostgresStorage",
  () => new PostgresStorage(process.env.KRETT_TEST_PG ?? "postgres://127.0.0.1:5432/postgres"),
  process.env.KRETT_TEST_PG !== undefined || process.env.CI === undefined,
);
