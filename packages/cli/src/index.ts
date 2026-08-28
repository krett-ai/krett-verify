#!/usr/bin/env node
/**
 * krett — init a quickstart, report on the failure corpus, watch it live.
 *
 *   krett init [path]
 *   krett report <db.sqlite> [--json] [--agent <id>] [--since <ISO|ms>]
 *   krett watch <db.sqlite> [--interval <ms>]
 */
import {init, report, watch} from "./commands.js";

export {init, report, watch, formatRecord} from "./commands.js";

const USAGE = `krett — Krett verifies what your agents actually did.

usage:
  krett init [path]                      write a runnable quickstart
  krett report <db> [--json]             summarize the failure corpus
              [--agent <id>] [--since <ISO|ms>]
  krett watch <db> [--interval <ms>]     stream new failures`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseSince(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) return asNumber;
  const asDate = Date.parse(value);
  return Number.isNaN(asDate) ? undefined : asDate;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const print = (line: string) => console.log(line);
  const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));

  switch (command) {
    case "init":
      return init(print, positional[0]);
    case "report": {
      if (!positional[0]) break;
      const options: {json?: boolean; agentId?: string; since?: number} = {};
      if (args.includes("--json")) options.json = true;
      const agent = flag(args, "--agent");
      if (agent) options.agentId = agent;
      const since = parseSince(flag(args, "--since"));
      if (since !== undefined) options.since = since;
      return report(print, positional[0], options);
    }
    case "watch": {
      if (!positional[0]) break;
      const interval = Number(flag(args, "--interval"));
      return watch(print, positional[0], Number.isFinite(interval) ? {intervalMs: interval} : {});
    }
    default:
      break;
  }
  console.log(USAGE);
  return command === undefined || command === "--help" || command === "help" ? 0 : 1;
}

// Only run as a CLI when executed directly, so tests can import the commands.
const invokedDirectly = process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("krett");
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
