/**
 * Browser checker: verifies "the page now shows X" claims by rendering the
 * URL through the checker's OWN client — a plain fetch by default, or an
 * injected renderer (e.g. a Playwright page the caller owns) for pages that
 * only exist after JavaScript runs. Never the agent's browser session
 * (AGENTS.md #10): a logged-in agent tab is agent-produced evidence.
 *
 * Claim conventions (system: "browser"):
 *   entity: "url:https://example.com/post/91"
 *   expect.contains:    string | string[] — substrings that must appear
 *   expect.notContains: string | string[] — substrings that must be absent
 *   expect.matches:     string            — a regex source the page must match
 * At least one expectation is required; a claim with none is unverifiable.
 * A renderer failure (network down, timeout) is unverifiable, never verified.
 */
import type {Checker, CheckerContext, Claim, Verdict} from "@krett/core";

export type PageRenderer = (url: string) => Promise<string>;

const defaultRenderer: PageRenderer = async (url) => {
  const response = await fetch(url, {redirect: "follow"});
  if (!response.ok) throw new Error(`page answered ${response.status}`);
  return await response.text();
};

function asList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

export class BrowserChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly render: PageRenderer;

  constructor(options: {render?: PageRenderer; id?: string} = {}) {
    this.id = options.id ?? "browser";
    this.render = options.render ?? defaultRenderer;
  }

  supports(claim: Claim): boolean {
    return claim.action.system === "browser" && claim.action.entity.startsWith("url:");
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const url = claim.action.entity.slice("url:".length);
    const expect = claim.action.expect as {
      contains?: string | string[];
      notContains?: string | string[];
      matches?: string;
    };
    const contains = asList(expect.contains);
    const notContains = asList(expect.notContains);
    if (contains.length === 0 && notContains.length === 0 && !expect.matches) {
      return this.verdict(claim, started, "unverifiable", null,
        "browser claims must state expect.contains, expect.notContains, or expect.matches");
    }

    let page: string;
    try {
      page = await this.render(url);
    } catch (error) {
      return this.verdict(claim, started, "unverifiable", null,
        `page render failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const evidence = {url, bytes: page.length};
    for (const needle of contains) {
      if (!page.includes(needle)) {
        return this.verdict(claim, started, "failed", evidence,
          `page does not contain ${JSON.stringify(needle)}`);
      }
    }
    for (const needle of notContains) {
      if (page.includes(needle)) {
        return this.verdict(claim, started, "failed", evidence,
          `page still contains ${JSON.stringify(needle)}`);
      }
    }
    if (expect.matches) {
      let pattern: RegExp;
      try {
        pattern = new RegExp(expect.matches);
      } catch {
        return this.verdict(claim, started, "unverifiable", evidence,
          `expect.matches is not a valid regex: ${JSON.stringify(expect.matches)}`);
      }
      if (!pattern.test(page)) {
        return this.verdict(claim, started, "failed", evidence,
          `page does not match /${expect.matches}/`);
      }
    }
    return this.verdict(claim, started, "verified", evidence);
  }

  private verdict(
    claim: Claim,
    started: number,
    status: Verdict["status"],
    evidence: unknown,
    reason?: string,
  ): Verdict {
    return {
      claimId: claim.id,
      status,
      checkerId: this.id,
      evidence,
      ...(reason ? {reason} : {}),
      latencyMs: Date.now() - started,
      timestamp: Date.now(),
    };
  }
}
