# Krett

**Krett verifies what your agents actually did.**

The independent verification and recovery layer for AI agents. Observability tells you what happened. Evals tell you if the model is good. Krett tells you whether the job actually got done in the real world, and fixes it when it didn't.

## The primitive

1. Every consequential agent action produces a **Claim**: what the agent says it did.
2. Every Claim gets a **Verdict** from an independent **Checker** that inspects the real system through a path the agent did not control: `verified`, `failed`, or `unverifiable`.
3. A `failed` Verdict triggers **Recovery**: retry, rollback, escalate, or quarantine.
4. Every failure becomes an append-only **FailureRecord**.

A checker never trusts the agent's own report. If independent confirmation is impossible, the honest verdict is `unverifiable`, never `verified`.

## Status

Under active construction, building in public. Phase plan in [KRETT.md](./KRETT.md); build spec in [PROMPT.md](./PROMPT.md); inviolable constraints in [AGENTS.md](./AGENTS.md).

- [ ] Phase 1: `@krett/core` — claim/verdict engine
- [ ] Phase 2: `@krett/checkers` — the checker library
- [ ] Phase 3: `@krett/recover` — recovery strategies
- [ ] Phase 4: `@krett/sdk` + `@krett/cli`
- [ ] Phase 5: [SilentBench](https://github.com/krett-ai/silentbench) — measuring the silent-failure rate of agent stacks

## License

Apache-2.0
