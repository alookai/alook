

export type ReleaseVersion = readonly [major: number, minor: number, patch: number];

const RELEASE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseReleaseVersion(value: string): ReleaseVersion | null {
  const match = RELEASE_VERSION_PATTERN.exec(value);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return null;
  return [major, minor, patch];
}

export function releaseVersionGte(a: string, b: string): boolean {
  const parsedA = parseReleaseVersion(a);
  const parsedB = parseReleaseVersion(b);
  if (!parsedA || !parsedB) return false;
  for (let i = 0; i < parsedA.length; i++) {
    if (parsedA[i]! > parsedB[i]!) return true;
    if (parsedA[i]! < parsedB[i]!) return false;
  }
  return true;
}
