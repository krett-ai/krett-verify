/**
 * @krett-ai/sdk — the five-minute path to verified agents.
 *
 *   const k = krett({checkers: [new FilesystemChecker()]});
 *   const verdict = await k.verify({agentId, action, consequence: "high"});
 *
 * The SDK never softens the engine's law: a verdict of `verified` only ever
 * comes from an independent checker reading the world itself.
 */
import {randomUUID} from "node:crypto";
import {KrettEngine} from "@krett-ai/core";
import type {
  Claim,
  ClaimAction,
  ConsequenceLevel,
  EngineOptions,
  FailureRecord,
  Verdict,
} from "@krett-ai/core";

export interface ClaimInput {
  agentId: string;
  action: ClaimAction;
  /** Defaults to "medium": verified async, retried, escalated on failure. */
  consequence?: ConsequenceLevel;
  runId?: string;
  id?: string;
  /** Attached to any FailureRecord this claim produces. */
  context?: Record<string, unknown>;
}

export class Krett {
  readonly engine: KrettEngine;

  constructor(options: EngineOptions) {
    this.engine = new KrettEngine(options);
  }

  /** Submit one claim and get its verdict (recovery runs on `failed`). */
  async verify(input: ClaimInput): Promise<Verdict> {
    const claim: Claim = {
      id: input.id ?? randomUUID(),
      agentId: input.agentId,
      runId: input.runId ?? "default",
      timestamp: Date.now(),
      action: input.action,
      consequence: input.consequence ?? "medium",
    };
    return this.engine.submit(claim, input.context ? {context: input.context} : {});
  }

  failures(filter?: {agentId?: string; since?: number}): Promise<FailureRecord[]> {
    return this.engine.failureRecords(filter);
  }

  on(event: "verdict" | "failure" | "recovery", listener: (payload: unknown) => void): this {
    this.engine.on(event, listener);
    return this;
  }

  async close(): Promise<void> {
    await this.engine.close();
  }
}

export function krett(options: EngineOptions): Krett {
  return new Krett(options);
}

export {wrapMcpClient, wrapPlaywright} from "./wrappers.js";
export type {ClaimSpec, McpClientLike, McpToolCall, WrapOptions} from "./wrappers.js";
export {KRETT_VERSION, defaultPolicy} from "@krett-ai/core";
export type {ClaimAction, ConsequenceLevel, Verdict, FailureRecord} from "@krett-ai/core";
