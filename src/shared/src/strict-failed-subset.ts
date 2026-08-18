export type StrictFailedSubsetOptions<T> = {
  isTarget(value: unknown): value is T;
  key(target: T): string;
};

/**
 * Validate a failure list against the exact targets from the originating
 * request. Wire-shape validation stays with each transport; this primitive
 * owns the shared subset and duplicate invariants.
 */
export function parseStrictFailedSubset<T>(
  value: unknown,
  requested: readonly T[],
  options: StrictFailedSubsetOptions<T>,
): T[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const allowed = new Set(requested.map(options.key));
  const seen = new Set<string>();
  const failed: T[] = [];

  for (const candidate of value) {
    if (!options.isTarget(candidate)) return null;
    const key = options.key(candidate);
    if (!allowed.has(key) || seen.has(key)) return null;
    seen.add(key);
    failed.push(candidate);
  }

  return failed;
}
