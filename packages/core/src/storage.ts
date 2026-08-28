/**
 * Storage adapters. FailureRecords are append-only by law (AGENTS.md #2): this
 * interface exposes no update and no delete for them, and no adapter may add
 * one. SQLite is the zero-config default; Postgres is the production option.
 */
import type {Claim, FailureRecord, Verdict} from "./types.js";

export interface StorageAdapter {
  saveClaim(claim: Claim): Promise<void>;
  saveVerdict(verdict: Verdict): Promise<void>;
  appendFailureRecord(record: FailureRecord): Promise<void>;
  getClaim(id: string): Promise<Claim | null>;
  getVerdicts(claimId: string): Promise<Verdict[]>;
  getFailureRecords(filter?: {agentId?: string; since?: number}): Promise<FailureRecord[]>;
  close(): Promise<void>;
}

/** In-memory adapter: tests and ephemeral runs. Same append-only discipline. */
export class MemoryStorage implements StorageAdapter {
  private claims = new Map<string, Claim>();
  private verdicts = new Map<string, Verdict[]>();
  private failures: FailureRecord[] = [];

  async saveClaim(claim: Claim): Promise<void> {
    this.claims.set(claim.id, claim);
  }

  async saveVerdict(verdict: Verdict): Promise<void> {
    const list = this.verdicts.get(verdict.claimId) ?? [];
    list.push(verdict);
    this.verdicts.set(verdict.claimId, list);
  }

  async appendFailureRecord(record: FailureRecord): Promise<void> {
    this.failures.push(Object.freeze(structuredClone(record)));
  }

  async getClaim(id: string): Promise<Claim | null> {
    return this.claims.get(id) ?? null;
  }

  async getVerdicts(claimId: string): Promise<Verdict[]> {
    return [...(this.verdicts.get(claimId) ?? [])];
  }

  async getFailureRecords(filter?: {agentId?: string; since?: number}): Promise<FailureRecord[]> {
    return this.failures.filter(
      (r) =>
        (!filter?.agentId || r.claim.agentId === filter.agentId) &&
        (!filter?.since || r.createdAt >= filter.since),
    );
  }

  async close(): Promise<void> {
    /* nothing to release */
  }
}
