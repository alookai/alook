export function semverGte(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const sa = pa[i] ?? 0;
    const sb = pb[i] ?? 0;
    if (sa > sb) return true;
    if (sa < sb) return false;
  }
  return true;
}
