/**
 * MCP agent example: an ops agent writes an incident postmortem through an
 * MCP filesystem server. The server truncates long writes but still reports
 * success — the trace is clean, the file is wrong. The wrapped client
 * verifies every mapped tool call against the real file, so the lie is
 * caught the moment it happens.
 *
 * Exits 0 when Krett catches the injected failure, 1 if it slips through.
 */
import {mkdtempSync, readFileSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {FilesystemChecker} from "@krett-ai/checkers";
import {krett, wrapMcpClient} from "@krett-ai/sdk";

const dir = mkdtempSync(join(tmpdir(), "krett-mcp-example-"));
const REQUIRED_LINE = "Root cause: connection pool exhaustion at 14:07 UTC.";

// A stand-in for any MCP client. The write_file tool truncates content over
// 200 bytes and reports success anyway — the injected silent failure.
const mcpClient = {
  async callTool({name, arguments: args}) {
    if (name !== "write_file") throw new Error(`unknown tool ${name}`);
    writeFileSync(join(dir, args.path), String(args.content).slice(0, 200));
    return {ok: true, bytesWritten: String(args.content).length}; // it lies
  },
};

const k = krett({checkers: [new FilesystemChecker()]});
const verdicts = [];

const client = wrapMcpClient(k, mcpClient, {
  agentId: "ops-agent",
  claimFor: (call) =>
    call.name === "write_file"
      ? {
          action: {
            verb: "write",
            system: "filesystem",
            entity: join(dir, call.arguments.path),
            expect: {contains: REQUIRED_LINE},
          },
          consequence: "high",
        }
      : null,
  onVerdict: (verdict, call) => {
    verdicts.push(verdict);
    console.log(`${call.name} -> tool said ok, checker says: ${verdict.status}${verdict.reason ? ` (${verdict.reason})` : ""}`);
  },
});

// The agent does its work and, judging by the tool result, succeeds.
const postmortem = [
  "# Incident 42 postmortem",
  "",
  "Impact: checkout down 22 minutes. Detection: pager at 14:09 UTC.",
  "Timeline: 14:07 first errors, 14:12 rollback started, 14:29 recovered.",
  "Contributing factors: pool size unchanged since 2024 load profile.",
  REQUIRED_LINE,
].join("\n");
const result = await client.callTool({name: "write_file", arguments: {path: "incident-42.md", content: postmortem}});
console.log(`agent saw: ${JSON.stringify(result)}`);
console.log(`file on disk ends with: ...${readFileSync(join(dir, "incident-42.md"), "utf8").slice(-40)}`);

const failures = await k.failures({agentId: "ops-agent"});
console.log(`failures recorded: ${failures.length}`);
await k.close();

const caught = verdicts.some((v) => v.status === "failed") && failures.length > 0;
console.log(caught ? "PASS: the injected silent failure was caught" : "FAIL: the lie slipped through");
process.exit(caught ? 0 : 1);
