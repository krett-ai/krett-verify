/**
 * Filesystem checker: verifies file create/modify/delete claims by reading the
 * filesystem itself — never the agent's report of it.
 *
 * Claim conventions (system: "filesystem", entity: file path; relative paths
 * resolve against the checker process's working directory):
 *   expect.exists: boolean        — file presence after the action
 *   expect.sha256: string         — content hash (hex)
 *   expect.contains: string       — substring the content must include
 *   expect.minBytes: number      — minimum size
 * Any subset may be supplied; all supplied keys must hold for `verified`.
 */
import {createHash} from "node:crypto";
import {readFile, stat} from "node:fs/promises";
import {resolve} from "node:path";
import type {Checker, CheckerContext, Claim, Verdict} from "@krett-ai/core";

interface Observation {
  exists: boolean;
  sha256?: string;
  size?: number;
  contains?: Record<string, boolean>;
}

export class FilesystemChecker implements Checker {
  readonly id: string;
  readonly access = "read" as const;

  constructor(options: {id?: string} = {}) {
    this.id = options.id ?? "filesystem";
  }

  supports(claim: Claim): boolean {
    return claim.action.system === "filesystem" && claim.action.entity.length > 0;
  }

  async check(claim: Claim, _ctx: CheckerContext): Promise<Verdict> {
    const started = Date.now();
    const path = resolve(claim.action.entity);
    const expect = claim.action.expect as {
      exists?: boolean;
      sha256?: string;
      contains?: string;
      minBytes?: number;
    };

    let observation: Observation;
    try {
      observation = await this.observe(path, expect);
    } catch (error) {
      return this.verdict(claim, started, "unverifiable", null,
        `filesystem read failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const problem = this.compare(observation, expect);
    return problem
      ? this.verdict(claim, started, "failed", observation, problem)
      : this.verdict(claim, started, "verified", observation);
  }

  private async observe(
    path: string,
    expect: {sha256?: string; contains?: string},
  ): Promise<Observation> {
    let size: number;
    try {
      size = (await stat(path)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {exists: false};
      throw error; // permission errors etc.: genuinely unverifiable
    }
    const observation: Observation = {exists: true, size};
    if (expect.sha256 !== undefined || expect.contains !== undefined) {
      const content = await readFile(path);
      observation.sha256 = createHash("sha256").update(content).digest("hex");
      if (expect.contains !== undefined) {
        observation.contains = {[expect.contains]: content.includes(expect.contains)};
      }
    }
    return observation;
  }

  private compare(
    seen: Observation,
    expect: {exists?: boolean; sha256?: string; contains?: string; minBytes?: number},
  ): string | null {
    if (expect.exists !== undefined && seen.exists !== expect.exists) {
      return `expected exists=${expect.exists}, observed exists=${seen.exists}`;
    }
    if (expect.exists === false) return null; // deletion claims need nothing further
    if (!seen.exists) return "file does not exist";
    if (expect.sha256 !== undefined && seen.sha256 !== expect.sha256) {
      return `content hash mismatch: expected ${expect.sha256.slice(0, 12)}…, observed ${seen.sha256?.slice(0, 12)}…`;
    }
    if (expect.contains !== undefined && !seen.contains?.[expect.contains]) {
      return `content does not contain "${expect.contains}"`;
    }
    if (expect.minBytes !== undefined && (seen.size ?? 0) < expect.minBytes) {
      return `expected at least ${expect.minBytes} bytes, observed ${seen.size ?? 0}`;
    }
    return null;
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
