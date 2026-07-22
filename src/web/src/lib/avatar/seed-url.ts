/**
 * Serialization for the beam-avatar stored value: `avatar:beam:{seed}`.
 *
 * Stored in the same `user.image` / `agent.avatarUrl` TEXT column that used to
 * hold the legacy `avatar:{shape,eye,nose,bg}` config. The two prefixes
 * (`avatar:beam:` vs `avatar:{`) are distinguishable, and the renderer only
 * honors this one — legacy configs fall through to an id-seeded beam.
 */

const BEAM_PREFIX = "avatar:beam:"

export function serializeBeamSeed(seed: string): string {
  return BEAM_PREFIX + seed
}

export function parseBeamSeed(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(BEAM_PREFIX)) return null
  const seed = url.slice(BEAM_PREFIX.length)
  return seed.length > 0 ? seed : null
}

/** A stored beam value with a fresh random seed — for newly-created entities. */
export function randomBeamAvatar(): string {
  return serializeBeamSeed(crypto.randomUUID())
}
