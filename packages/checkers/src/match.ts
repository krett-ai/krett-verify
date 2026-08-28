/**
 * Shared expectation matching: dot-path reads over an API resource, compared
 * as strings because providers disagree on scalar typing. Keys beginning with
 * "$" are directives, not fields, and are skipped here.
 */
export function dig(resource: unknown, path: string): unknown {
  let current: unknown = resource;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** First mismatch as a human-readable problem, or null when everything holds. */
export function compareExpect(
  resource: unknown,
  expect: Record<string, unknown>,
): string | null {
  for (const [path, want] of Object.entries(expect)) {
    if (path.startsWith("$")) continue;
    const observed = dig(resource, path);
    if (String(observed) !== String(want)) {
      return `expected ${path}=${JSON.stringify(want)}, observed ${JSON.stringify(observed)}`;
    }
  }
  return null;
}
