/** Row-state checkers: happy path, agent-lies-caught, unreachable. */
import {describe, expect, it, afterAll} from "vitest";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import type {Claim} from "@krett/core";
import {PostgresRowChecker, SqliteRowChecker} from "../src/index.js";

function claim(system: string, entity: string, expect_: Record<string, unknown>): Claim {
  return {
    id: `c-${Math.random().toString(36).slice(2, 8)}`,
    agentId: "a1",
    runId: "r1",
    timestamp: Date.now(),
    action: {verb: "update", system, entity, expect: expect_},
    consequence: "high",
  };
}

describe("SqliteRowChecker", () => {
  const dir = mkdtempSync(join(tmpdir(), "krett-db-"));
  const dbPath = join(dir, "app.db");
  const db = new Database(dbPath);
  db.exec("CREATE TABLE contacts (id TEXT PRIMARY KEY, stage TEXT)");
  db.prepare("INSERT INTO contacts (id, stage) VALUES ('42', 'lost')").run();
  db.close();
  const checker = new SqliteRowChecker({path: dbPath});

  it("verifies true row state", async () => {
    const v = await checker.check(claim("sqlite", "contacts:id:42", {stage: "lost"}), {});
    expect(v.status).toBe("verified");
  });

  it("catches the agent claiming an update that never happened", async () => {
    const v = await checker.check(claim("sqlite", "contacts:id:42", {stage: "won"}), {});
    expect(v.status).toBe("failed");
    expect(v.reason).toContain("expected stage");
  });

  it("catches a claimed insert that does not exist, and verifies deletes", async () => {
    const missing = await checker.check(claim("sqlite", "contacts:id:99", {stage: "won"}), {});
    expect(missing.status).toBe("failed");
    const deleted = await checker.check(claim("sqlite", "contacts:id:99", {$exists: false}), {});
    expect(deleted.status).toBe("verified");
  });

  it("a missing database file is unverifiable", async () => {
    const dead = new SqliteRowChecker({path: join(dir, "nope.db")});
    const v = await dead.check(claim("sqlite", "contacts:id:42", {stage: "lost"}), {});
    expect(v.status).toBe("unverifiable");
  });

  it("rejects hostile identifiers before they reach SQL", () => {
    expect(checker.supports(claim("sqlite", 'contacts";DROP TABLE x;--:id:1', {}))).toBe(false);
  });
});

describe.skipIf(process.env.CI !== undefined && process.env.KRETT_TEST_PG === undefined)(
  "PostgresRowChecker",
  () => {
    const url = process.env.KRETT_TEST_PG ?? "postgres://127.0.0.1:5432/postgres";
    const table = `krett_chk_${Date.now()}`;
    const checker = new PostgresRowChecker({url});
    afterAll(() => checker.close());

    it("verifies, catches lies, and handles absence against a real database", async () => {
      const {default: postgres} = await import("postgres");
      const sql = postgres(url, {max: 1});
      await sql.unsafe(`CREATE TABLE ${table} (id text PRIMARY KEY, stage text)`);
      await sql.unsafe(`INSERT INTO ${table} VALUES ('7', 'lost')`);
      try {
        const ok = await checker.check(claim("postgres", `${table}:id:7`, {stage: "lost"}), {});
        expect(ok.status).toBe("verified");
        const lie = await checker.check(claim("postgres", `${table}:id:7`, {stage: "won"}), {});
        expect(lie.status).toBe("failed");
        const gone = await checker.check(claim("postgres", `${table}:id:8`, {$exists: false}), {});
        expect(gone.status).toBe("verified");
      } finally {
        await sql.unsafe(`DROP TABLE ${table}`);
        await sql.end({timeout: 5});
      }
    });

    it("an unreachable server is unverifiable", async () => {
      const dead = new PostgresRowChecker({url: "postgres://127.0.0.1:59999/nope"});
      const v = await dead.check(claim("postgres", "contacts:id:1", {stage: "x"}), {});
      expect(v.status).toBe("unverifiable");
      await dead.close();
    });
  },
);
