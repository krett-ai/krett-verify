/**
 * GitHub checker: verifies repo-world claims ("I opened the PR", "I pushed
 * that commit", "I cut the release") by reading the GitHub REST API with the
 * checker's OWN token (AGENTS.md #10) — never by trusting the agent's output.
 *
 * Claim conventions (system: "github"):
 *   entity forms:
 *     "pr:owner/repo#123"          — a pull request
 *     "issue:owner/repo#45"        — an issue
 *     "commit:owner/repo@sha"      — a commit
 *     "branch:owner/repo@name"     — a branch head
 *     "release:owner/repo@tag"     — a release by tag
 *     "repo:owner/repo"            — the repository itself
 *   expect: dot-path -> expected value, compared against the API resource
 *           ("state": "open", "merged": true, "head.ref": "fix-ci").
 *           The special key "$exists": false asserts the resource is absent
 *           (API 404), e.g. a branch the agent claims to have deleted.
 *
 * A 404 is evidence of absence; auth failures and network errors are
 * `unverifiable` — the only safe direction when the world can't be read.
 */
import type {Checker, CheckerContext, Claim, Verdict} from "@krett/core";

type FetchLike = (url: string, init?: {headers?: Record<string, string>}) => Promise<{
  status: number;
  json(): Promise<unknown>;
}>;

const ENTITY = /^(pr|issue|commit|branch|release|repo):([\w.-]+\/[\w.-]+)(?:[#@](.+))?$/;

function apiPath(kind: string, repo: string, ref: string | undefined): string | null {
  switch (kind) {
    case "repo":
      return `/repos/${repo}`;
    case "pr":
      return ref ? `/repos/${repo}/pulls/${ref}` : null;
    case "issue":
      return ref ? `/repos/${repo}/issues/${ref}` : null;
    case "commit":
      return ref ? `/repos/${repo}/commits/${ref}` : null;
    case "branch":
      return ref ? `/repos/${repo}/branches/${encodeURIComponent(ref)}` : null;
    case "release":
      return ref ? `/repos/${repo}/releases/tags/${encodeURIComponent(ref)}` : null;
    default:
      return null;
  }
}

function dig(resource: unknown, path: string): unknown {
  let current: unknown = resource;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export class GithubChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;
  private readonly token: string | undefined;
  private readonly apiBase: string;
  private readonly fetchFn: FetchLike;

  constructor(options: {id?: string; token?: string; apiBase?: string; fetchFn?: FetchLike} = {}) {
    this.id = options.id ?? "github";
    this.token = options.token;
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? (fetch as unknown as FetchLike);
  }

  supports(claim: Claim): boolean {
    return claim.action.system === "github" && ENTITY.test(claim.action.entity);
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const match = ENTITY.exec(claim.action.entity);
    if (!match) {
      return this.verdict(claim, started, "unverifiable", null,
        'entity must look like "pr:owner/repo#123", "commit:owner/repo@sha", or "repo:owner/repo"');
    }
    const kind = match[1] ?? "";
    const repo = match[2] ?? "";
    const path = apiPath(kind, repo, match[3]);
    if (!path) {
      return this.verdict(claim, started, "unverifiable", null,
        `entity kind "${kind}" requires a #number or @ref suffix`);
    }

    let status: number;
    let resource: unknown = null;
    try {
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "user-agent": "krett-checker",
      };
      if (this.token) headers.authorization = `Bearer ${this.token}`;
      const response = await this.fetchFn(`${this.apiBase}${path}`, {headers});
      status = response.status;
      if (status === 200) resource = await response.json();
    } catch (error) {
      return this.verdict(claim, started, "unverifiable", null,
        `github read failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const expect = claim.action.expect;
    const wantsAbsence = expect["$exists"] === false;
    if (status === 404) {
      return wantsAbsence
        ? this.verdict(claim, started, "verified", {status})
        : this.verdict(claim, started, "failed", {status}, `${kind} ${claim.action.entity} does not exist`);
    }
    if (status !== 200) {
      return this.verdict(claim, started, "unverifiable", {status},
        `github answered ${status}; cannot read the resource independently`);
    }
    if (wantsAbsence) {
      return this.verdict(claim, started, "failed", {status},
        "expected the resource to be absent, but it exists");
    }

    for (const [path_, want] of Object.entries(expect)) {
      if (path_ === "$exists") continue;
      const observed = dig(resource, path_);
      if (String(observed) !== String(want)) {
        return this.verdict(claim, started, "failed", {status, [path_]: observed},
          `expected ${path_}=${JSON.stringify(want)}, observed ${JSON.stringify(observed)}`);
      }
    }
    return this.verdict(claim, started, "verified", {status});
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
