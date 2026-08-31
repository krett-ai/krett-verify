/**
 * Browser agent example: an agent drives a Playwright-shaped page to register
 * an on-call contact. The page's fill() silently drops the email field, the
 * thank-you screen still says success — the classic lying confirmation. The
 * wrapped page verifies the submit against the application's own database
 * through Krett's separate read path, so the dropped field is caught.
 *
 * Exits 0 when Krett catches the injected failure, 1 if it slips through.
 */
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import Database from "better-sqlite3";
import {SqliteRowChecker} from "@krett-ai/checkers";
import {krett, wrapPlaywright} from "@krett-ai/sdk";

const dir = mkdtempSync(join(tmpdir(), "krett-browser-example-"));
const dbPath = join(dir, "app.db");
const db = new Database(dbPath);
db.exec("CREATE TABLE contacts (id INTEGER PRIMARY KEY, name TEXT, email TEXT)");

// A stand-in for a Playwright page driving a signup form. fill() drops the
// email field on the floor; click('#submit') persists what survived and the
// page happily shows a thank-you screen — the injected silent failure.
const fields = {};
const page = {
  async goto() {},
  async fill(selector, value) {
    if (selector === "#email") return; // dropped, no error, no trace
    fields[selector.slice(1)] = value;
  },
  async click(selector) {
    if (selector !== "#submit") return;
    db.prepare("INSERT INTO contacts (id, name, email) VALUES (1, ?, ?)").run(fields.name ?? null, fields.email ?? null);
    return "Thanks! Your on-call contact is registered.";
  },
};

const k = krett({checkers: [new SqliteRowChecker({path: dbPath})]});
const verdicts = [];

const wrapped = wrapPlaywright(k, page, {
  agentId: "signup-agent",
  claimFor: (call) =>
    call.method === "click" && call.args[0] === "#submit"
      ? {
          action: {
            verb: "submit",
            system: "sqlite",
            entity: "contacts:id:1",
            expect: {name: "Lin Park", email: "lin@oncall.example.com"},
          },
          consequence: "high",
        }
      : null,
  onVerdict: (verdict, call) => {
    verdicts.push(verdict);
    console.log(`${call.method}(${JSON.stringify(call.args[0])}) -> page said thanks, checker says: ${verdict.status}${verdict.reason ? ` (${verdict.reason})` : ""}`);
  },
});

// The agent fills the form and submits; every signal it can see says success.
await wrapped.goto("https://oncall.example.com/register");
await wrapped.fill("#name", "Lin Park");
await wrapped.fill("#email", "lin@oncall.example.com");
await wrapped.click("#submit");

const failures = await k.failures({agentId: "signup-agent"});
console.log(`row in database: ${JSON.stringify(db.prepare("SELECT * FROM contacts WHERE id = 1").get())}`);
console.log(`failures recorded: ${failures.length}`);
db.close();
await k.close();

const caught = verdicts.some((v) => v.status === "failed") && failures.length > 0;
console.log(caught ? "PASS: the injected silent failure was caught" : "FAIL: the lie slipped through");
process.exit(caught ? 0 : 1);
