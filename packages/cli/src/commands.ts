/**
 * CLI commands, kept as plain functions with an injected writer so they are
 * testable without spawning processes. The CLI reads FailureRecords; it never
 * updates or deletes them (AGENTS.md #2).
 */
import {existsSync} from "node:fs";
import {writeFile} from "node:fs/promises";
import {SqliteStorage} from "@krett/core";
import type {FailureRecord} from "@krett/core";

export type Print = (line: string) => void;

const QUICKSTART = `// Krett quickstart: catch an agent lying about a file write.
// Run: node krett-quickstart.mjs
import {writeFile} from "node:fs/promises";
import {krett} from "@krett/sdk";
import {FilesystemChecker} from "@krett/checkers";

const k = krett({checkers: [new FilesystemChecker()]});

// The "agent" claims it wrote a receipt. It actually wrote something else.
await writeFile("receipt.txt", "TOTAL: $0.00 (oops, wrong template)");

const verdict = await k.verify({
  agentId: "billing-agent",
  action: {
    verb: "write",
    system: "filesystem",
    entity: "receipt.txt",
    expect: {contains: "TOTAL: $49.00"},
  },
  consequence: "high",
});

console.log(verdict.status, "-", verdict.reason ?? "the claim held");
console.log("failures recorded:", (await k.failures()).length);
await k.close();
`;

export async function init(print: Print, path = "krett-quickstart.mjs"): Promise<number> {
  if (existsSync(path)) {
    print(`refusing to overwrite ${path}`);
    return 1;
  }
  await writeFile(path, QUICKSTART);
  print(`wrote ${path}`);
  print("next: pnpm add @krett/sdk @krett/checkers && node " + path);
  return 0;
}

function tally<T>(items: T[], key: (item: T) => string): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

export async function report(
  print: Print,
  dbPath: string,
  options: {json?: boolean; agentId?: string; since?: number} = {},
): Promise<number> {
  if (!existsSync(dbPath)) {
    print(`no database at ${dbPath}`);
    return 1;
  }
  const storage = new SqliteStorage(dbPath);
  try {
    const filter: {agentId?: string; since?: number} = {};
    if (options.agentId) filter.agentId = options.agentId;
    if (options.since) filter.since = options.since;
    const records = await storage.getFailureRecords(filter);

    if (options.json) {
      const summary = {
        failures: records.length,
        resolutions: Object.fromEntries(tally(records, (r) => r.resolution)),
        agents: Object.fromEntries(tally(records, (r) => r.claim.agentId)),
        systems: Object.fromEntries(tally(records, (r) => r.claim.action.system)),
      };
      print(JSON.stringify(summary, null, 2));
      return 0;
    }

    print(`failures caught: ${records.length}`);
    if (records.length === 0) return 0;
    print("");
    print("by resolution:");
    for (const [resolution, count] of tally(records, (r) => r.resolution)) {
      print(`  ${resolution.padEnd(12)} ${count}`);
    }
    print("by agent:");
    for (const [agent, count] of tally(records, (r) => r.claim.agentId)) {
      print(`  ${agent.padEnd(12)} ${count}`);
    }
    print("by system:");
    for (const [system, count] of tally(records, (r) => r.claim.action.system)) {
      print(`  ${system.padEnd(12)} ${count}`);
    }
    print("");
    print("most recent:");
    for (const record of records.slice(-5)) {
      print(`  ${formatRecord(record)}`);
    }
    return 0;
  } finally {
    await storage.close();
  }
}

export function formatRecord(record: FailureRecord): string {
  const when = new Date(record.createdAt).toISOString();
  const what = `${record.claim.agentId} ${record.claim.action.verb} ${record.claim.action.entity}`;
  const why = record.verdict.reason ?? "claim did not hold";
  return `${when} [${record.resolution}] ${what} — ${why}`;
}

export async function watch(
  print: Print,
  dbPath: string,
  options: {intervalMs?: number; once?: boolean} = {},
): Promise<number> {
  if (!existsSync(dbPath)) {
    print(`no database at ${dbPath}`);
    return 1;
  }
  const storage = new SqliteStorage(dbPath);
  const interval = options.intervalMs ?? 2000;
  let since = 0;
  print(`watching ${dbPath} for new failures (every ${interval}ms)`);
  try {
    for (;;) {
      const fresh = await storage.getFailureRecords({since});
      for (const record of fresh) {
        print(formatRecord(record));
        since = Math.max(since, record.createdAt + 1);
      }
      if (options.once) return 0;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  } finally {
    await storage.close();
  }
}
