// Variable-width decimal discriminator (`name#0042`) derived from a seed via
// FNV-1a modulo 10^width. The DEFAULT width is 4 (`"0000"`–`"9999"`); the
// allocator widens by one digit per exhausted collision budget so a name's tag
// pool never caps (see withUniqueDiscriminator). Derived from the immutable id,
// not the name — but rename-stability rests on the STORED value being written
// once and never recomputed (the disc is opaque; the UNIQUE index is the sole
// arbiter), not on recomputability. Stored on `user.discriminator` (0051) /
// `community_server.discriminator` (0079).

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
 * Compute a decimal discriminator for a seed at the given width.
 *
 * - Deterministic: same (seed, width) → same output, no clock / random inputs.
 * - Zero-padded to EXACTLY `width` digits (`computeDiscriminator(id)` === the
 *   pre-widening 4-digit value byte-for-byte, so existing rows never rotate).
 * - Padded to its OWN width — a width-5 disc is 5 digits (an honest "the 4-digit
 *   pool was saturated" signal), never padded up to a uniform global width.
 */
export function computeDiscriminator(seed: string, width = 4): string {
  return (fnv1a32(seed) % 10 ** width).toString().padStart(width, "0");
}

/**
 * Parse a `name#0042` search string into its two halves.
 * Returns `null` when the string doesn't match the format (name may contain
 * `#`; only the LAST `#dddd` suffix — 4+ decimal digits — is treated as a tag).
 * `\d{4,}` (length, not charset) so a widened 5+-digit tag still parses; the
 * LAST `#` split keeps a name that itself ends in digits (`user123#4567`)
 * splitting to exactly one (name, discriminator).
 */
export function parseNameAndTag(
  q: string
): { name: string; discriminator: string } | null {
  const m = /^(.+)#(\d{4,})$/.exec(q);
  if (!m) return null;
  const name = m[1]!.trim();
  const discriminator = m[2]!;
  if (!name) return null;
  return { name, discriminator };
}

/**
 * Build the canonical global-handle string, `name#0042`. The ONE place this
 * string is assembled — every call site (system prompt, `agentHandle`,
 * message wire `sender`/`latestSender`, DM refs) goes through this instead of
 * hand-rolling the template literal, so the format can't drift.
 */
export function formatHandle(name: string, discriminator: string): string {
  return `${name}#${discriminator}`;
}
