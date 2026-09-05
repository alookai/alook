const MAX_REDIRECT_BYTES = 2048;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function isSafeCandidate(value: string): boolean {
  return value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !value.includes("#")
    && !CONTROL_CHARACTERS.test(value);
}

export function isSafeRedirectPath(value: string): boolean {
  if (new TextEncoder().encode(value).byteLength > MAX_REDIRECT_BYTES) return false;
  if (!isSafeCandidate(value)) return false;

  let decoded = value;
  for (let depth = 0; depth < 8; depth += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return depth > 0;
    }
    if (next === decoded) break;
    if (!isSafeCandidate(next)) return false;
    decoded = next;
    if (depth === 7) return false;
  }

  try {
    const base = new URL("https://alook.invalid");
    const resolved = new URL(value, base);
    return resolved.origin === base.origin;
  } catch {
    return false;
  }
}

export function safeRedirectPath(
  value: string | null | undefined,
  fallback = "/c/me",
): string {
  return value && isSafeRedirectPath(value) ? value : fallback;
}
