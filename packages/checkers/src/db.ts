/**
 * Database checkers: verify row-level state claims by reading the database
 * directly, through the checker's OWN connection — by law (AGENTS.md #10) a
 * separate credential from whatever the agent used.
 *
 * Claim conventions (system: "sqlite" | "postgres"):
 *   entity: "table:keyColumn:keyValue"   e.g. "users:id:42"
 *   expect: column -> expected value; the special key "$exists": false asserts
 *           the row is absent (delete claims).
 * Identifier names (table, key column, expected columns) are validated against
 * a strict pattern before ever entering SQL.
 */
import type {Checker, CheckerContext, Claim, Verdict} from "@krett-ai/core";

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface ParsedEntity {
  table: string;
  keyColumn: string;
  keyValue: string;
}

function parseEntity(entity: string): ParsedEntity | null {
  const parts = entity.split(":");
  if (parts.length !== 3) return null;
  const [table, keyColumn, keyValue] = parts as [string, string, string];
  if (!IDENT.test(table) || !IDENT.test(keyColumn) || keyValue.length === 0) return null;
  return {table, keyColumn, keyValue};
}

function compareRow(
  row: Record<string, unknown> | null,
  expect: Record<string, unknown>,
): string | null {
  const wantsAbsence = expect["$exists"] === false;
  if (wantsAbsence) return row === null ? null : "expected row to be absent, but it exists";
  if (row === null) return "row does not exist";
  for (const [column, want] of Object.entries(expect)) {
    if (column === "$exists") continue;
    if (!IDENT.test(column)) return `invalid expected column name "${column}"`;
    // Loose scalar comparison: drivers differ on number/string typing.
    if (String(row[column]) !== String(want)) {
      return `expected ${column}=${JSON.stringify(want)}, observed ${JSON.stringify(row[column])}`;
    }
  }
  return null;
}

function makeVerdict(
  claim: Claim,
  checkerId: string,
  started: number,
  status: Verdict["status"],
  evidence: unknown,
  reason?: string,
): Verdict {
  return {
    claimId: claim.id,
    status,
    checkerId,
    evidence,
    ...(reason ? {reason} : {}),
    latencyMs: Date.now() - started,
    timestamp: Date.now(),
  };
}

/** Shared logic; subclasses provide the independent row reader. */
abstract class RowStateChecker implements Checker {
  abstract readonly id: string;
  readonly access = "read" as const;
  protected abstract readonly system: string;
  protected abstract readRow(parsed: ParsedEntity): Promise<Record<string, unknown> | null>;

  supports(claim: Claim): boolean {
    return claim.action.system === this.system && parseEntity(claim.action.entity) !== null;
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const parsed = parseEntity(claim.action.entity);
    if (!parsed) {
      return makeVerdict(claim, this.id, started, "unverifiable", null,
        'entity must be "table:keyColumn:keyValue"');
    }
    let row: Record<string, unknown> | null;
    try {
      row = await this.readRow(parsed);
    } catch (error) {
      return makeVerdict(claim, this.id, started, "unverifiable", null,
        `database read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const problem = compareRow(row, claim.action.expect);
    return problem
      ? makeVerdict(claim, this.id, started, "failed", {row}, problem)
      : makeVerdict(claim, this.id, started, "verified", {row});
  }
}

export class SqliteRowChecker extends RowStateChecker {
  readonly id: string;
  protected readonly system = "sqlite";
  private db: import("better-sqlite3").Database | null = null;
  private readonly path: string;

  constructor(options: {path: string; id?: string}) {
    super();
    this.id = options.id ?? "sqlite-row";
    this.path = options.path;
  }

  protected async readRow(parsed: ParsedEntity): Promise<Record<string, unknown> | null> {
    if (!this.db) {
      const {default: Database} = await import("better-sqlite3");
      this.db = new Database(this.path, {readonly: true, fileMustExist: true});
    }
    const row = this.db
      .prepare(`SELECT * FROM "${parsed.table}" WHERE "${parsed.keyColumn}" = ?`)
      .get(parsed.keyValue) as Record<string, unknown> | undefined;
    return row ?? null;
  }
}

export class PostgresRowChecker extends RowStateChecker {
  readonly id: string;
  protected readonly system = "postgres";
  private sql: import("postgres").Sql | null = null;
  private readonly url: string;

  constructor(options: {url: string; id?: string}) {
    super();
    this.id = options.id ?? "postgres-row";
    this.url = options.url;
  }

  protected async readRow(parsed: ParsedEntity): Promise<Record<string, unknown> | null> {
    if (!this.sql) {
      const {default: postgres} = await import("postgres");
      this.sql = postgres(this.url, {max: 2, connect_timeout: 5});
    }
    const rows = await this.sql`
      SELECT * FROM ${this.sql(parsed.table)}
      WHERE ${this.sql(parsed.keyColumn)} = ${parsed.keyValue}`;
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  async close(): Promise<void> {
    await this.sql?.end({timeout: 5});
  }
}
