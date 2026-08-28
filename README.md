# Krett

**Krett verifies what your agents actually did.**

The independent verification and recovery layer for AI agents. Observability tells you what happened. Evals tell you if the model is good. Krett tells you whether the job actually got done in the real world, and fixes it when it didn't.

## The primitive

1. Every consequential agent action produces a **Claim**: what the agent says it did.
2. Every Claim gets a **Verdict** from an independent **Checker** that inspects the real system through a path the agent did not control: `verified`, `failed`, or `unverifiable`.
3. A `failed` Verdict triggers **Recovery**: retry (re-verified), rollback (verified), escalate, or quarantine.
4. Every failure becomes an append-only **FailureRecord**.

A checker never trusts the agent's own report. If independent confirmation is impossible, the honest verdict is `unverifiable`, never `verified`.

## Quickstart

```js
import {krett} from "@krett/sdk";
import {FilesystemChecker} from "@krett/checkers";

const k = krett({checkers: [new FilesystemChecker()]});

// The agent claims it wrote the receipt. Did it?
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

console.log(verdict.status); // "verified" | "failed" | "unverifiable"
```

Or wrap what you already run — every mapped tool call gets independently verified after it returns:

```js
import {krett, wrapMcpClient} from "@krett/sdk";

const verified = wrapMcpClient(k, mcpClient, {
  agentId: "ops-agent",
  claimFor: (call) => ({
    action: {verb: call.name, system: "email", entity: `message:${call.arguments.id}`,
             expect: {last_event: "delivered"}},
    consequence: "high",
  }),
  onVerdict: (v) => v.status !== "verified" && alertOncall(v),
});
```

CLI:

```
krett init          # write a runnable quickstart that catches an injected lie
krett report db     # summarize the failure corpus (--json, --agent, --since)
krett watch db      # stream new failures as they land
```

## Packages

| Package | What it is |
|---|---|
| `@krett/core` | Claim/verdict engine, policies, memory/sqlite/postgres storage |
| `@krett/checkers` | Filesystem, sqlite/postgres rows, ledger (exact bigint money math), GitHub, email, browser, plus generic state/probe/invariant/HTTP checkers |
| `@krett/recover` | The recovery ladder: retry re-verified, rollback verified, escalate, exact per-agent quarantine |
| `@krett/sdk` | `krett()`, `verify()`, `wrapMcpClient`, `wrapPlaywright` |
| `@krett/cli` | `krett init` / `report` / `watch` |

## Status

Building in public. Phase plan in [KRETT.md](./KRETT.md); build spec in [PROMPT.md](./PROMPT.md); inviolable constraints in [AGENTS.md](./AGENTS.md).

- [x] Phase 1: `@krett/core` — claim/verdict engine
- [x] Phase 2: `@krett/checkers` — the checker library
- [x] Phase 3: `@krett/recover` — recovery strategies
- [x] Phase 4: `@krett/sdk` + `@krett/cli` (npm publish pending)
- [ ] Phase 5: [SilentBench](https://github.com/krett-ai/silentbench) — measuring the silent-failure rate of agent stacks

## License

Apache-2.0
