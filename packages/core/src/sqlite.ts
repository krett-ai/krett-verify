/**
 * SQLite storage: the zero-config default (AGENTS.md #8). One file, no server.
 *
 * Append-only law (AGENTS.md #2): this adapter contains no UPDATE and no DELETE
 * for failure records, and none may ever be added. Claims and verdicts are
 * insert-only too; corrections happen by appending new rows, never rewriting.
 *
 * Dependency note (AGENTS.md #9): better-sqlite3 is the standard synchronous
 * SQLite binding; chosen over node:sqlite for Node 20 support.
 */
import Database from "better-sqlite3";
import type {Claim, FailureRecord, Verdict} from "./types.js";
import type {StorageAdapter} from "./storage.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS claims (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  consequence TEXT NOT NULL,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS verdicts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  claim_id TEXT NOT NULL,
  status TEXT NOT NULL,
  checker_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS verdicts_claim_idx ON verdicts (claim_id);
CREATE TABLE IF NOT EXISTS failure_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS failures_agent_idx ON failure_records (agent_id, created_at);
`;

export class SqliteStorage implements StorageAdapter {
  private readonly db: Database.Database;

  constructor(path = "krett.db") {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  async saveClaim(claim: Claim): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO claims (id, agent_id, run_id, timestamp, consequence, body) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(claim.id, claim.agentId, claim.runId, claim.timestamp, claim.consequence, JSON.stringify(claim));
  }

  async saveVerdict(verdict: Verdict): Promise<void> {
    this.db
      .prepare(
        "INSERT INTO verdicts (claim_id, status, checker_id, timestamp, body) VALUES (?, ?, ?, ?, ?)",
      )
      .run(verdict.claimId, verdict.status, verdict.checkerId, verdict.timestamp, JSON.stringify(verdict));
  }

  async appendFailureRecord(record: FailureRecord): Promise<void> {
    this.db
      .prepare("INSERT INTO failure_records (id, agent_id, created_at, body) VALUES (?, ?, ?, ?)")
      .run(record.id, record.claim.agentId, record.createdAt, JSON.stringify(record));
  }

  async getClaim(id: string): Promise<Claim | null> {
    const row = this.db.prepare("SELECT body FROM claims WHERE id = ?").get(id) as
      | {body: string}
      | undefined;
    return row ? (JSON.parse(row.body) as Claim) : null;
  }

  async getVerdicts(claimId: string): Promise<Verdict[]> {
    const rows = this.db
      .prepare("SELECT body FROM verdicts WHERE claim_id = ? ORDER BY id")
      .all(claimId) as {body: string}[];
    return rows.map((r) => JSON.parse(r.body) as Verdict);
  }

  async getFailureRecords(filter?: {agentId?: string; since?: number}): Promise<FailureRecord[]> {
    const rows = this.db
      .prepare(
        "SELECT body FROM failure_records WHERE (? IS NULL OR agent_id = ?) AND created_at >= ? ORDER BY created_at",
      )
      .all(filter?.agentId ?? null, filter?.agentId ?? null, filter?.since ?? 0) as {body: string}[];
    return rows.map((r) => JSON.parse(r.body) as FailureRecord);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
