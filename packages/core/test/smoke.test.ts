import {describe, expect, it} from "vitest";
import {KRETT_VERSION, type VerdictStatus} from "../src/index.js";

describe("workspace smoke", () => {
  it("exports a version", () => {
    expect(KRETT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("verdict statuses are the canonical three", () => {
    const statuses: VerdictStatus[] = ["verified", "failed", "unverifiable"];
    expect(statuses).toHaveLength(3);
  });
});
