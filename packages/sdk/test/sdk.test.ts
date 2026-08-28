/**
 * SDK: verify() ergonomics plus both wrappers, each proven against a fake
 * world the checker reads independently of the "agent".
 */
import {describe, expect, it} from "vitest";
import type {Checker} from "@krett/core";
import {krett, wrapMcpClient, wrapPlaywright} from "../src/index.js";
import type {McpToolCall, PageCall} from "../src/wrappers.js";

/** The world is a key/value store; the checker reads it directly. */
function worldChecker(world: Map<string, string>): Checker {
  return {
    id: "world",
    access: "read",
    supports: (c) => c.action.system === "world",
    check: async (c) => {
      const want = c.action.expect["value"];
      const observed = world.get(c.action.entity);
      return {
        claimId: c.id,
        status: observed === want ? "verified" : "failed",
        checkerId: "world",
        evidence: {observed},
        ...(observed === want ? {} : {reason: `observed ${JSON.stringify(observed)}`}),
        latencyMs: 0,
        timestamp: Date.now(),
      };
    },
  };
}

describe("krett().verify", () => {
  it("fills claim defaults and returns the independent verdict", async () => {
    const world = new Map([["greeting", "hello"]]);
    const k = krett({checkers: [worldChecker(world)]});
    const verdict = await k.verify({
      agentId: "a1",
      action: {verb: "write", system: "world", entity: "greeting", expect: {value: "hello"}},
    });
    expect(verdict.status).toBe("verified");

    const lie = await k.verify({
      agentId: "a1",
      action: {verb: "write", system: "world", entity: "greeting", expect: {value: "goodbye"}},
      consequence: "high",
      context: {tool: "test"},
    });
    expect(lie.status).toBe("failed");
    const failures = await k.failures({agentId: "a1"});
    expect(failures).toHaveLength(1);
    expect(failures[0]?.context).toEqual({tool: "test"});
    await k.close();
  });
});

describe("wrapMcpClient", () => {
  it("verifies mapped tool calls and catches a tool that lied", async () => {
    const world = new Map<string, string>();
    const k = krett({checkers: [worldChecker(world)]});
    const client = {
      // A buggy tool: reports success but only writes when the key is short.
      async callTool(params: McpToolCall) {
        const key = String(params.arguments?.["key"]);
        if (key.length <= 5) world.set(key, String(params.arguments?.["value"]));
        return {ok: true};
      },
    };
    const verdicts: string[] = [];
    const wrapped = wrapMcpClient(k, client, {
      agentId: "mcp-agent",
      claimFor: (call) => ({
        action: {
          verb: "write",
          system: "world",
          entity: String(call.arguments?.["key"]),
          expect: {value: String(call.arguments?.["value"])},
        },
        consequence: "high",
      }),
      onVerdict: (v) => verdicts.push(v.status),
    });

    const honest = await wrapped.callTool({name: "put", arguments: {key: "ok", value: "1"}});
    expect(honest).toEqual({ok: true});
    const silent = await wrapped.callTool({
      name: "put",
      arguments: {key: "too-long-key", value: "2"},
    });
    expect(silent).toEqual({ok: true}); // the tool STILL claims success...
    expect(verdicts).toEqual(["verified", "failed"]); // ...and Krett catches it.
    expect(await k.failures()).toHaveLength(1);
    await k.close();
  });

  it("leaves unmapped calls and other members untouched", async () => {
    const k = krett({checkers: []});
    const client = {
      name: "plain",
      async callTool() {
        return "raw";
      },
    };
    const wrapped = wrapMcpClient(k, client, {
      agentId: "a",
      claimFor: () => null,
    });
    expect(wrapped.name).toBe("plain");
    expect(await wrapped.callTool({name: "x"})).toBe("raw");
    expect(await k.failures()).toHaveLength(0);
    await k.close();
  });
});

describe("wrapPlaywright", () => {
  it("verifies page actions through an independent read of the page state", async () => {
    const world = new Map<string, string>();
    const page = {
      url: () => "https://example.com",
      // fill "works" but drops the value: the classic silent failure.
      async fill(selector: string, _value: string) {
        world.set(selector, "");
      },
      async goto(target: string) {
        world.set("location", target);
      },
    };
    const k = krett({checkers: [worldChecker(world)]});
    const verdicts: Array<[string, string]> = [];
    const wrapped = wrapPlaywright(k, page, {
      agentId: "browser-agent",
      claimFor: (call: PageCall) => ({
        action: {
          verb: call.method,
          system: "world",
          entity: call.method === "goto" ? "location" : String(call.args[0]),
          expect: {value: String(call.args[call.method === "goto" ? 0 : 1] ?? call.args[0])},
        },
      }),
      onVerdict: (v, call) => verdicts.push([call.method, v.status]),
    });

    await wrapped.goto("https://example.com/checkout");
    await wrapped.fill("#card-name", "Ada Lovelace");
    expect(verdicts).toEqual([
      ["goto", "verified"],
      ["fill", "failed"],
    ]);
    expect(wrapped.url()).toBe("https://example.com"); // non-action members pass through
    await k.close();
  });
});
