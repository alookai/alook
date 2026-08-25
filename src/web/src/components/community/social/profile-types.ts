import type React from "react"
import type { Presence } from "@/lib/community/models/people"

// ── Profile ──────────────────────────────────────────────────────────────────
export type Profile = {
  name: string
  // Stable user id of the profile's owner — the exact-match key for DM-target
  // resolution and self-detection (never match by non-unique display name).
  // Optional so mock/older Profile-constructing sites keep type-checking.
  userId?: string
  // Variable-width (≥4-digit) decimal discriminator derived from user.id
  // (`"0042"`, widens on collision) — undefined while the profile fetch is in
  // flight. Shown at its true width, never re-padded. See computeDiscriminator
  // in @alook/shared.
  discriminator?: string
  avatar: string
  contextLabel?: string
  about: string
  mutual: number
  // Live online/offline dot on the card's avatar — undefined when no
  // member/friend match could be resolved (e.g. a stale mention). See
  // `resolveProfilePresence` in shell-frame.tsx.
  presence?: Presence
  // Hydrated API identity. Seeded cards intentionally omit this so the main
  // profile can paint before the public profile request resolves.
  identity?: ProfileIdentity
}

export type OwnerProfileRef = {
  id: string
  handle: string
}

type ProfileIdentity =
  | { kind: "human" }
  | {
      kind: "bot"
      ownerProfile: OwnerProfileRef
      ownedByViewer: boolean
    }

// Shared callback signature for opening a user's profile card at a click point.
// `userId` is the exact-match disambiguator — pass it whenever the caller
// already has the clicked person's userId (member rows, message authors,
// thread openers) so same-named members never collide. `discriminator` is
// the fallback disambiguator for a mention pill, which only carries a
// `#0042` tag (see message-markdown.tsx) and no userId.
export type OpenProfile = (
  name: string,
  e: React.MouseEvent,
  discriminator?: string,
  userId?: string,
) => void
