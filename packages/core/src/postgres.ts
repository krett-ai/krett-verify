/**
 * Postgres storage: the production option. Same append-only law as every
 * adapter (AGENTS.md #2): no UPDATE, no DELETE for failure records, ever.
 *
 * Dependency note (AGENTS.md #9): `postgres` (porsager) is a zero-dependency
 * driver; schema bootstrap is idempotent CREATE IF NOT EXISTS, and migrations
 * must preserve failure_records.
 */
import postgres from "postgres";
import type {Claim, FailureRecord, Verdict} from "./types.js";
import type {StorageAdapter} from "./storage.js";

export class PostgresStorage implements StorageAdapter {
  private readonly sql: postgres.Sql;
  private ready: Promise<void>;

  constructor(url: string) {
    this.sql = postgres(url, {max: 5});
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS krett_claims (
        id text PRIMARY KEY,
        agent_id text NOT NULL,
        run_id text NOT NULL,
        timestamp bigint NOT NULL,
        consequence text NOT NULL,
        body jsonb NOT NULL
      )`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS krett_verdicts (
        id bigserial PRIMARY KEY,
        claim_id text NOT NULL,
        status text NOT NULL,
        checker_id text NOT NULL,
        timestamp bigint NOT NULL,
        body jsonb NOT NULL
      )`;
    await this.sql`CREATE INDEX IF NOT EXISTS krett_verdicts_claim_idx ON krett_verdicts (claim_id)`;
    await this.sql`
      CREATE TABLE IF NOT EXISTS krett_failure_records (
        id text PRIMARY KEY,
        agent_id text NOT NULL,
        created_at bigint NOT NULL,
        body jsonb NOT NULL
      )`;
    await this.sql`
      CREATE INDEX IF NOT EXISTS krett_failures_agent_idx
      ON krett_failure_records (agent_id, created_at)`;
  }

  async saveClaim(claim: Claim): Promise<void> {
    await this.ready;
    await this.sql`
      INSERT INTO krett_claims (id, agent_id, run_id, timestamp, consequence, body)
      VALUES (${claim.id}, ${claim.agentId}, ${claim.runId}, ${claim.timestamp},
              ${claim.consequence}, ${this.sql.json(claim as never)})`;
  }

  async saveVerdict(verdict: Verdict): Promise<void> {
    await this.ready;
    await this.sql`
      INSERT INTO krett_verdicts (claim_id, status, checker_id, timestamp, body)
      VALUES (${verdict.claimId}, ${verdict.status}, ${verdict.checkerId},
              ${verdict.timestamp}, ${this.sql.json(verdict as never)})`;
  }

  async appendFailureRecord(record: FailureRecord): Promise<void> {
    await this.ready;
    await this.sql`
      INSERT INTO krett_failure_records (id, agent_id, created_at, body)
      VALUES (${record.id}, ${record.claim.agentId}, ${record.createdAt},
              ${this.sql.json(record as never)})`;
  }

  async getClaim(id: string): Promise<Claim | null> {
    await this.ready;
    const rows = await this.sql`SELECT body FROM krett_claims WHERE id = ${id}`;
    return rows.length > 0 ? (rows[0]!.body as Claim) : null;
  }

  async getVerdicts(claimId: string): Promise<Verdict[]> {
    await this.ready;
    const rows = await this.sql`
      SELECT body FROM krett_verdicts WHERE claim_id = ${claimId} ORDER BY id`;
    return rows.map((r) => r.body as Verdict);
  }

  async getFailureRecords(filter?: {agentId?: string; since?: number}): Promise<FailureRecord[]> {
    await this.ready;
    const rows = await this.sql`
      SELECT body FROM krett_failure_records
      WHERE (${filter?.agentId ?? null}::text IS NULL OR agent_id = ${filter?.agentId ?? null})
        AND created_at >= ${filter?.since ?? 0}
      ORDER BY created_at`;
    return rows.map((r) => r.body as FailureRecord);
  }

  async close(): Promise<void> {
    await this.sql.end({timeout: 5});
  }
}
