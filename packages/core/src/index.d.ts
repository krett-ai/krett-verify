/**
 * @krett/core — the claim/verdict engine.
 *
 * Krett verifies what your agents actually did. Phase 1 fills this package with
 * the Claim/Verdict/Checker types and the engine; this stub exists so the
 * workspace, CI, and publish pipeline are proven before any logic lands.
 */
export declare const KRETT_VERSION = "0.0.1";
/** The three verdict states. Independence law: never `verified` on agent-produced evidence. */
export type VerdictStatus = "verified" | "failed" | "unverifiable";
