export type CommunityRole = "owner" | "admin" | "member"
export type ChannelType = "text" | "forum"
// Every value the `community_channel.type` column can hold. DMs became channels
// with `type='dm'` in migration 0068 (`isDm` below has always checked for it),
// but this union previously omitted `dm` — a real type-level gap. Widened to
// the full stored set so code that switches on a channel's stored type is
// exhaustive over DM channels too.
//
// `forum_post` deleted: a post is now just an ordinary thread whose opener
// message happens to have a title-shaped `content` — no distinguishing type
// value, because a post under a forum has zero structural difference from
// any other thread. Migration 0082 type-flips every existing forum_post row
// to `thread` before this union narrows; the fold is zero-schema-difference
// by construction (see create-channels.ts's createMessageWithThread doc for
// the full shape).
export type StoredChannelType = "text" | "forum" | "thread" | "dm"

export const ROLES = {
  OWNER: "owner",
  ADMIN: "admin",
  MEMBER: "member",
} as const

export const ASSIGNABLE_ROLES = ["admin", "member"] as const
export type AssignableRole = typeof ASSIGNABLE_ROLES[number]

export const CHANNEL_TYPES = ["text", "forum"] as const

export function canManageServer(role?: string | null): boolean {
  return role === ROLES.OWNER || role === ROLES.ADMIN
}

export function isServerOwner(role?: string | null): boolean {
  return role === ROLES.OWNER
}

/**
 * The single private-channel visibility rule, shared by both access predicates
 * (`getChannelForMember` — read/post path — and `requireChannelAccess` /
 * `resolveChannelAccessContext` — manage path) plus `canBotReadWakeScope`, so
 * the rule can never drift between them. Only the unit's creator or an explicit
 * member may see a private channel/post. Callers only invoke this once they
 * know the anchor is private. Pure.
 *
 * NOTE: a server admin/owner has NO special CONTENT access to private units —
 * they see/read/post a private channel only if they created it or were added,
 * exactly like a normal member. Admins manage servers via admin-gated routes
 * (and the future Browse Channels settings surface), not by implicitly seeing
 * every private conversation. `role` is retained in the signature for callers
 * that still pass it, but it no longer grants visibility.
 */
export function canSeePrivateChannel(input: {
  role?: string | null | undefined
  isCreator: boolean
  isChannelMember: boolean
}): boolean {
  return input.isCreator || input.isChannelMember
}

export function isAssignableRole(role: unknown): role is AssignableRole {
  return typeof role === "string" && (ASSIGNABLE_ROLES as readonly string[]).includes(role)
}

export function isChannelType(t: unknown): t is ChannelType {
  return typeof t === "string" && (CHANNEL_TYPES as readonly string[]).includes(t)
}

export function isForum(t: string | null | undefined): boolean {
  return t === "forum"
}

export function isThread(t: string | null | undefined): boolean {
  return t === "thread"
}

export function isDm(t: string | null | undefined): boolean {
  return t === "dm"
}

// Every stored type is message-bearing — a channel/forum/thread/DM can all
// receive a send. This IS isStoredChannelType(t); kept as its own named
// predicate so send/react/pin call sites read as "is this surface legitimate
// to write to," not a re-derived type check (phase2 forum≡thread reversed
// this from an allowlist that excluded plain `forum` — see git history on
// this function for that transition).
export function isMessageBearingSurface(t: string | null | undefined): boolean {
  return isStoredChannelType(t)
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel-type TRAIT model (plan: unify-forum-forumpost-channel-thread B0).
//
// A channel `type` is not one fact but a COMBINATION of orthogonal behavioral
// traits (Aigneis's decomposition, thread /Alook/discuss/#462): three read/
// routing axes — how you ADDRESS it, who can SEE it, who it REACHES — plus one
// write axis, how it's CREATED. Historically each axis was hand-branched on the
// `type` literal in four separate places (resolver / write-guard / inbox /
// permissions), so the SAME per-type fact lived in N copies and drifted (the
// agent thread-inbox deadlock was one axis — participation — written twice and
// diverging). This table makes each type = one row of trait VALUES, and every
// consuming face dispatches on the trait, not the type literal. Adding a type is
// picking existing values from closed enums; adding a value forces (via an
// exhaustive `switch` with a `never` check) every face to handle it or fail to
// compile — so a red-line (single addressing identity / existence
// non-disclosure / never-drop reach) holds BY CONSTRUCTION, not by prose.
//
// Each axis is a CLOSED enum, deliberately NOT an open config object: that is
// what forbids "configure this type to skip the block check / leak existence".
// The miss/collision semantics are welded to the enum VALUE, not tunable per
// type. Do NOT widen these to free-form options.
//
// Rollout is staged (B0 = this table, pure add, nothing reads it yet; B1 =
// addressing; B2 = reach incl. enroll; B3 = visibility/access; B4 = creation).
// So today NO face consumes CHANNEL_TRAITS — it is behavior-inert until B1+.

// How a channel is located from a CLI ref (read axis). Consumed by the resolver
// (parse → id) and the single canonical-ref emitter (id → ref), which must read
// the SAME value so a type can never have two addressing paths (red-line ①).
//   by-server-name  — `/server/<name>`; top-level, name unique per server.
//   by-root-seq     — `/server/<channel>/#<rootSeq>`; anchored on root msg seq.
//   by-peer-identity— `/.dm/<peer#0042>`; the OTHER access member's handle.
// (`by-child-name` — `/server/<forum>/<post>` — deleted with forum_post,
// phase2 forum≡thread: a post's only addressing was by its own slug under
// the forum; a post is now an ordinary thread, addressed by-root-seq like
// any other.)
export type AddressingTrait = "by-server-name" | "by-root-seq" | "by-peer-identity"

// Who can SEE the channel (read axis). The miss semantics (no access → 404, the
// existence-non-disclosure red-line ②) are welded to the value, not per-type.
//   own-roster      — its own server-membership / private-category roster.
//   inherit-parent  — climbs `parentChannelId` to the parent forum/channel's
//                     roster + privacy (a thread is not its own unit).
//   dm-participant  — the two `relation='access'` DM members; the sole surviving
//                     403 (block of a known participant) lives inside this value.
export type VisibilityTrait = "own-roster" | "inherit-parent" | "dm-participant"

// Who a message REACHES / gets notified (read+write axis). One value drives BOTH
// halves from a single source (red-line ③): the read predicate (fanout + inbox
// "is this deliverable" agree) AND the write-side enroll (who gets a notify row
// on send). Splitting them is exactly the thread-deadlock drift.
//   server-or-roster— the whole server (public) or private-category roster.
//   participant-set — the notify set: author + spoke + @-mentioned enroll rows.
//   dm-pair         — the two DM participants.
export type ReachTrait = "server-or-roster" | "participant-set" | "dm-pair"

// How a channel is CREATED (write axis) — what a name/anchor COLLISION means.
// Consumed by the create path (B4). Each value names EXACTLY ONE observable
// collision contract, so it carries exactly one definition-level
// existence-oracle (Aigneis's B0 criterion, #45) — a value that spanned two
// contracts (e.g. 409-reject AND bump) would have two end states and no
// single assertable oracle, collapsing the by-construction win back to
// per-type hand-verification.
//   get-or-create      — the anchor identifies ONE unit; a collision re-selects
//                        and returns the existing winner (idempotent open — DM,
//                        thread). Contract: collision → fetch winner, 1 unit.
//   reject-on-collision— a same-name create is REFUSED (409, 0 rows) by the
//                        `idx_channel_server_name` unique index; the caller must
//                        rename (top-level text/forum, human-admin-created). NOT
//                        a singleton (many channels may exist, just not same-name)
//                        and NOT "no create" (it is a real create path with a real
//                        409 contract). Contract: collision → 0 rows + 409.
// (`pure-create` — a slug collision bumps and retries, N distinct rows,
// never merged — deleted with forum_post, phase2 forum≡thread: it was the
// sole user of this contract. A post's opener is now created via
// createMessageWithThread, which doesn't go through this dispatch at all —
// see create-channels.ts.)
export type CreationTrait = "get-or-create" | "reject-on-collision"
export type MessagePropertyType = "tag" | "emoji" | "mark"

export type ChannelTraits = {
  addressing: AddressingTrait
  visibility: VisibilityTrait
  reach: ReachTrait
  creation: CreationTrait
  messageProperties: readonly MessagePropertyType[]
}

// The single source of truth mapping each stored channel type to its trait
// values. Extracted from today's hand-branched behavior — B0 is behavior-
// invariant (see the axis docs above for where each value comes from).
//
// `text`/`forum` creation = `reject-on-collision`: a top-level channel create is
// human-admin-only and a same-name create is REFUSED (409, 0 rows) by the
// `idx_channel_server_name` unique index.
export const CHANNEL_TRAITS: Record<StoredChannelType, ChannelTraits> = {
  text: { addressing: "by-server-name", visibility: "own-roster", reach: "server-or-roster", creation: "reject-on-collision", messageProperties: ["emoji", "mark"] },
  forum: { addressing: "by-server-name", visibility: "own-roster", reach: "server-or-roster", creation: "reject-on-collision", messageProperties: ["tag", "mark"] },
  thread: { addressing: "by-root-seq", visibility: "inherit-parent", reach: "participant-set", creation: "get-or-create", messageProperties: ["emoji", "mark"] },
  dm: { addressing: "by-peer-identity", visibility: "dm-participant", reach: "dm-pair", creation: "get-or-create", messageProperties: ["emoji", "mark"] },
}

export function messagePropertyCapabilities(t: StoredChannelType): readonly MessagePropertyType[] {
  return CHANNEL_TRAITS[t].messageProperties
}

export function supportsMessageProperty(
  t: string | null | undefined,
  property: MessagePropertyType,
): boolean {
  return isStoredChannelType(t) && messagePropertyCapabilities(t).includes(property)
}

// ── reach axis (B2) — the SINGLE source for "who does a message here reach" ────
// The reach model of a channel type used to be re-derived as `isThread(t)`
// (→ participant set) vs `isDm(t)` (→ DM pair) vs else (→ server) in THREE
// places: fan-out recipients (who-receives), the agent-inbox
// deliverable-unread narrowing (which channels need participation), and the
// send-path enroll (who-enrolls into the notify set). Three copies of one
// classification = drift (the agent thread-inbox deadlock was two of them
// diverging). Now all three read the reach VALUE from CHANNEL_TRAITS via the
// helpers below, so the classification lives in exactly one place. Critically,
// the read side (who's-participant) and the write side (who-enrolls) key on the
// SAME value (`participant-set`) — a message enrolls participants iff its reach
// is participant-set, and the deliverable/fan-out predicate reads that same set,
// so enroll and read can never drift (red-line ③).

// The reach model for a stored channel type — the one classification the three
// reach faces branch on. A plain lookup so it's impossible to have a second
// copy of "which types are participant-set".
export function channelReach(t: StoredChannelType): ReachTrait {
  return CHANNEL_TRAITS[t].reach
}

// A message in a channel of this type ENROLLS participants on send (author +
// @-mentioned/replied) AND its recipients/deliverable set are read from that
// same participant set. True iff the reach value is `participant-set`
// (thread). This is the single predicate the enroll write-side and the
// participation-narrowing read-side share — they are two ends of one reach
// value, never separately maintained (red-line ③).
export function reachIsParticipantSet(t: string | null | undefined): boolean {
  return isStoredChannelType(t) && channelReach(t) === "participant-set"
}

// A narrow type guard so the reach helpers can accept the loosely-typed
// `type` columns/params (string | null) that flow through the query layer.
export function isStoredChannelType(t: string | null | undefined): t is StoredChannelType {
  return t === "text" || t === "forum" || t === "thread" || t === "dm"
}

// ── visibility axis (B3) — how the ACCESS CHECK runs (NOT the miss status) ─────
// The visibility trait names HOW a channel resolves access, the one classification
// the access functions branch on. Deliberately does NOT cover the miss STATUS
// (no-access → 403 vs 404): that translation is surface-partitioned (human →
// 403 in requireChannelMember; agent → 404 via the existence-mask collapse), an
// axis ORTHOGONAL to type — welding it here would compress the surface dimension
// into the type dimension (a false convergence). So a null (not visible) is still
// returned by the access functions and translated by the caller per surface;
// this trait only picks the resolution STRATEGY.
//   dm-participant → the `relation='access'` member check, no server walk, no
//                    parent inheritance (a DM is its own access unit).
//   own-roster / inherit-parent → the server-membership + private-category path,
//                    with the anchor climb (`parentChannelId ?? id`) that makes a
//                    thread inherit its parent's roster. That climb is
//                    already a single uniform idiom, so these two values share the
//                    same code path today; the value records the intent.
export function channelVisibility(t: StoredChannelType): VisibilityTrait {
  return CHANNEL_TRAITS[t].visibility
}

// The DM access rule: resolve access via the `relation='access'` member row with
// no server walk / no inheritance. True iff visibility is `dm-participant`. This
// is the single predicate the two access functions (`getChannelForMember`,
// `resolveChannelAccessContext`) share for their DM special-case, instead of each
// re-testing `type === 'dm'` (B3 — the DM access rule's 2→1). Does NOT decide the
// miss status (403/404) — that stays in the caller's surface-partitioned layer.
export function visibilityIsDmParticipant(t: string | null | undefined): boolean {
  return isStoredChannelType(t) && channelVisibility(t) === "dm-participant"
}

// ── creation axis (B4) — what a name/anchor COLLISION means ───────────────────
// The creation trait names the collision contract of a channel type, read by the
// create path so "what happens when the name/anchor already exists" is chosen
// from one place, not hand-branched per type. Each value = exactly one observable
// contract = exactly one existence-oracle (Aigneis's B0 criterion):
//   get-or-create      → the anchor is ONE unit; a collision re-selects the
//                        existing winner (idempotent open — DM, thread).
//   reject-on-collision→ a same-name create is refused (409, 0 rows) by a unique
//                        index (top-level text/forum).
export function channelCreation(t: StoredChannelType): CreationTrait {
  return CHANNEL_TRAITS[t].creation
}

// ── NOT a trait axis: display / human-readable title ──────────────────────────
// A forum post's `display_title` (its pre-slugify original title) is DELIBERATELY
// absent from this table. It is ZERO-behavior — no face (resolver / write-guard /
// inbox / permissions) reads it; it is pure presentation. Addressing always
// resolves via the key the `addressing` trait names (`name` = the slug), NEVER a
// human title. Do NOT "add display to a trait axis" when introducing a type
// (the tempting misread: "names address, so display belongs in addressing") —
// that would re-merge the slug (machine address) and the readable title (human
// display), the exact split this model keeps apart. Readable identity lives in a
// display-only column and never becomes a second addressable path.
