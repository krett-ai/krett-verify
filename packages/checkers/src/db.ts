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

/**
 * A missing table is a definitive observation, not a read failure: the claimed
 * row provably does not exist. Subclasses translate their driver's
 * table-missing error into row-absent so presence claims fail and absence
 * claims verify. Everything else that breaks a read (missing database file,
 * bad credentials, network) stays unverifiable — those don't prove anything
 * about the row.
 */
class TableMissingError extends Error {}

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
    let tableMissing = false;
    try {
      row = await this.readRow(parsed);
    } catch (error) {
      if (error instanceof TableMissingError) {
        row = null;
        tableMissing = true;
      } else {
        return makeVerdict(claim, this.id, started, "unverifiable", null,
          `database read failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    let problem = compareRow(row, claim.action.expect);
    if (problem && tableMissing) problem = `table "${parsed.table}" does not exist, so the row cannot`;
    return problem
      ? makeVerdict(claim, this.id, started, "failed", {row, ...(tableMissing ? {tableMissing} : {})}, problem)
      : makeVerdict(claim, this.id, started, "verified", {row, ...(tableMissing ? {tableMissing} : {})});
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
    let statement: import("better-sqlite3").Statement;
    try {
      statement = this.db.prepare(`SELECT * FROM "${parsed.table}" WHERE "${parsed.keyColumn}" = ?`);
    } catch (error) {
      if (error instanceof Error && /no such table/.test(error.message)) {
        throw new TableMissingError(error.message);
      }
      throw error;
    }
    const row = statement.get(parsed.keyValue) as Record<string, unknown> | undefined;
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
    let rows: import("postgres").RowList<import("postgres").Row[]>;
    try {
      rows = await this.sql`
        SELECT * FROM ${this.sql(parsed.table)}
        WHERE ${this.sql(parsed.keyColumn)} = ${parsed.keyValue}`;
    } catch (error) {
      // 42P01: undefined_table
      if ((error as {code?: string}).code === "42P01") {
        throw new TableMissingError((error as Error).message);
      }
      throw error;
    }
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  async close(): Promise<void> {
    await this.sql?.end({timeout: 5});
  }
}
