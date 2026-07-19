import type { Member, Friend, Profile } from "./_types"
import type { CurrentUser } from "@/contexts/community/current-user"
import { resolveProfilePresence } from "@/lib/community/presence"
import { avatarInitial } from "@/lib/community/avatar"

/**
 * The signed-in viewer's own profile card, built straight from `currentUser`.
 *
 * A profile-card click that already knows it targets the viewer (UserBar, or
 * any caller passing the viewer's own userId) resolves here instead of through
 * `resolveProfileTarget`. Name-based resolution can't be trusted for self: the
 * viewer's own member row only exists in `members` while a server is active, so
 * on `/c/me` the name-only fallback would match a same-named friend (or miss
 * entirely) and show the wrong person.
 */
export function buildSelfProfile(
  currentUser: CurrentUser,
  onlineUserIds: ReadonlySet<string>,
): Profile {
  return {
    name: currentUser.name,
    userId: currentUser.id,
    discriminator: currentUser.discriminator,
    avatar: currentUser.avatar || avatarInitial(currentUser.name),
    role: "You",
    about: currentUser.aboutMe ?? "",
    mutual: 0,
    presence: resolveProfilePresence(true, undefined, onlineUserIds),
  }
}

/**
 * Resolves the exact member/friend a profile-card click refers to.
 *
 * Priority order — exact-match first, so same-named members never collide:
 *   1. `userId` — the caller already knows the clicked person's id (member
 *      rows, message authors, thread openers all carry it).
 *   2. `discriminator` — a mention pill's `#0042` tag; no userId available
 *      there, but the tag still disambiguates an exact same-named person.
 *   3. Name-only fallback — legacy behavior for callers with neither.
 *
 * Extracted from `shell-frame.tsx`'s `openProfile` so this lookup logic can
 * be unit-tested without spinning up the full shell component (this repo has
 * no jsdom/testing-library setup for rendering it).
 */
export function resolveProfileTarget(
  members: Member[] | undefined,
  friends: Friend[] | undefined,
  target: { name: string; discriminator?: string; userId?: string },
): Member | Friend | undefined {
  const { name, discriminator, userId } = target
  return (userId
    ? (members ?? []).find((m) => m.userId === userId)
    ?? (friends ?? []).find((f) => f.userId === userId)
    : undefined)
    ?? (discriminator
      ? (members ?? []).find((m) => m.name === name && m.discriminator === discriminator)
      ?? (friends ?? []).find((f) => f.name === name && f.discriminator === discriminator)
      : undefined)
    ?? (members ?? []).find((m) => m.name === name)
    ?? (friends ?? []).find((f) => f.name === name)
}
