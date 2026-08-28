/**
 * Wrappers: put verification in the agent's path without rewriting the agent.
 *
 * Both wrappers are structural — no dependency on the MCP SDK or Playwright.
 * The caller supplies claimFor: Krett cannot guess what a tool call was
 * supposed to change in the world, and refuses to pretend otherwise. Calls
 * with no claim mapping pass through unverified BY THE CALLER'S CHOICE;
 * everything mapped is verified independently.
 */
import type {ClaimAction, ConsequenceLevel, Verdict} from "@krett/core";
import type {Krett} from "./index.js";

export interface ClaimSpec {
  action: ClaimAction;
  consequence?: ConsequenceLevel;
  context?: Record<string, unknown>;
}

export interface McpToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface McpClientLike {
  callTool(params: McpToolCall, ...rest: unknown[]): Promise<unknown>;
}

export interface WrapOptions<Call> {
  agentId: string;
  runId?: string;
  /** Map a completed call to the claim it implies; null = caller opts out. */
  claimFor: (call: Call, result: unknown) => ClaimSpec | null;
  onVerdict?: (verdict: Verdict, call: Call) => void;
}

async function verifyCall<Call>(
  k: Krett,
  options: WrapOptions<Call>,
  call: Call,
  result: unknown,
): Promise<void> {
  const spec = options.claimFor(call, result);
  if (!spec) return;
  const verdict = await k.verify({
    agentId: options.agentId,
    ...(options.runId ? {runId: options.runId} : {}),
    action: spec.action,
    ...(spec.consequence ? {consequence: spec.consequence} : {}),
    ...(spec.context ? {context: spec.context} : {}),
  });
  options.onVerdict?.(verdict, call);
}

/**
 * Wrap an MCP client so every callTool the mapping covers is followed by an
 * independent verification of its claimed effect.
 */
export function wrapMcpClient<T extends McpClientLike>(
  k: Krett,
  client: T,
  options: WrapOptions<McpToolCall>,
): T {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "callTool") return Reflect.get(target, prop, receiver);
      return async (params: McpToolCall, ...rest: unknown[]) => {
        const result = await target.callTool(params, ...rest);
        await verifyCall(k, options, params, result);
        return result;
      };
    },
  });
}

export interface PageCall {
  method: string;
  args: unknown[];
}

const PAGE_ACTIONS = new Set([
  "goto",
  "click",
  "dblclick",
  "fill",
  "type",
  "press",
  "check",
  "uncheck",
  "selectOption",
  "setInputFiles",
  "tap",
]);

/**
 * Wrap a Playwright page (or anything shaped like one) so state-changing
 * actions the mapping covers are verified after they run.
 */
export function wrapPlaywright<T extends object>(
  k: Krett,
  page: T,
  options: WrapOptions<PageCall>,
): T {
  return new Proxy(page, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop !== "string" || !PAGE_ACTIONS.has(prop) || typeof value !== "function") {
        return value;
      }
      return async (...args: unknown[]) => {
        const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        await verifyCall(k, options, {method: prop, args}, result);
        return result;
      };
    },
  });
}
