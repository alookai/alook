// 4-digit user discriminator (`name#0042`) derived from user.id via FNV-1a
// modulo 10 000. Hash on the immutable id, not the name, so renames don't
// rotate a user's tag. Stored on `user.discriminator` (see migration 0051).

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;

function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_BASIS_32;
  const bytes = new TextEncoder().encode(input);
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    // 32-bit unsigned multiply — `Math.imul` handles overflow correctly,
    // `>>> 0` coerces the result back to Uint32.
    hash = Math.imul(hash, FNV_PRIME_32) >>> 0;
  }
  return hash;
}

/**
 * Compute the 4-digit discriminator for a user id.
 *
 * - Deterministic: same id → same output, no clock / random inputs.
 * - Always exactly 4 characters, zero-padded (`"0042"`, not `"42"`).
 * - Range `"0000"`–`"9999"`.
 */
export function computeDiscriminator(userId: string): string {
  return (fnv1a32(userId) % 10000).toString().padStart(4, "0");
}

/**
 * Parse a `name#0042` search string into its two halves.
 * Returns `null` when the string doesn't match the exact format
 * (name may contain `#`; only the LAST `#dddd` suffix is treated as a tag).
 */
export function parseNameAndTag(
  q: string
): { name: string; discriminator: string } | null {
  const m = /^(.+)#(\d{4})$/.exec(q);
  if (!m) return null;
  const name = m[1]!.trim();
  const discriminator = m[2]!;
  if (!name) return null;
  return { name, discriminator };
}
