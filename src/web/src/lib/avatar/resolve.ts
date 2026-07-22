/**
 * Resolves a stored avatar value into what to render.
 *
 * Priority: a real photo URL wins; then a `avatar:beam:{seed}` value renders
 * beam with its stored seed; everything else — null, or a legacy
 * `avatar:{shape…}` config that we deliberately no longer honor — falls back
 * to an id-seeded beam.
 */
import { isPhotoAvatarUrl } from "@/components/avatar/photo"
import { parseBeamSeed } from "./seed-url"

export type ResolvedAvatar =
  | { kind: "photo"; url: string }
  | { kind: "beam"; seed: string }

export function resolveAvatar(
  value: string | null | undefined,
  fallbackSeed: string,
): ResolvedAvatar {
  if (isPhotoAvatarUrl(value)) return { kind: "photo", url: value! }
  const beamSeed = parseBeamSeed(value)
  if (beamSeed) return { kind: "beam", seed: beamSeed }
  return { kind: "beam", seed: fallbackSeed }
}
