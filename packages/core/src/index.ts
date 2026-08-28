/**
 * @krett/core — the claim/verdict engine.
 *
 * Krett verifies what your agents actually did. Every consequential agent
 * action produces a Claim; every Claim gets a Verdict from an independent
 * Checker; failed Verdicts dispatch recovery; every failure is an append-only
 * FailureRecord.
 */
import {defaultPolicy} from "./types.js";
import {MemoryStorage} from "./storage.js";
import {KrettEngine} from "./engine.js";

export const KRETT_VERSION = "0.0.1";

export {defaultPolicy, MemoryStorage, KrettEngine};

export type {
  Checker,
  CheckerAccess,
  CheckerContext,
  Claim,
  ClaimAction,
  ConsequenceLevel,
  FailureRecord,
  Policy,
  PolicyLevel,
  RecoveryAction,
  RecoveryDispatcher,
  RecoveryType,
  VerdictStatus,
  Verdict,
  VerificationTiming,
} from "./types.js";
export type {StorageAdapter} from "./storage.js";
export type {EngineOptions, SubmitOptions} from "./engine.js";
