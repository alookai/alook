import {
  queries,
  slugify,
  channelCreation,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_MESSAGE_CONTENT_LENGTH,
  type Database,
} from "@alook/shared"
import { createCommunityMessage } from "./message-handler"
import { createWithCollisionPolicy } from "./create-collision"

/**
 * Shared core for CREATING a forum post — the single implementation both the
 * human New-Post route (`channels/[id]/posts` POST) and the bot verb
 * (`createPost` POST, `alook message post`) call. Extracting it is the B4
 * creation-axis convergence: "what a name collision means" is chosen ONCE, by
 * dispatching on the forum-post type's `creation` trait, instead of each caller
 * hand-rolling slug dedupe + create + first-message.
 *
 * `forum_post`'s creation trait is `pure-create`: each post is a distinct unit,
 * and a slug collision BUMPS a new slug (`ideas` → `ideas-2`) and retries the
 * insert — it NEVER merges into an existing post (that would be get-or-create,
 * a thread/DM contract). The retry loop below catches the partial-unique-index
 * violation and re-bumps.
 *
 * ⚠ SHIP-ORDER CONSTRAINT (Aigneis / Blondie, thread /Alook/discuss/#462): the
 * bump-retry's RACE-safety depends on the `(parent_channel_id, name)` partial
 * unique index (migration 0078, B4b). WITHOUT that index a concurrent
 * same-title create silently double-inserts (the original race — two posts,
 * both "succeed", sharing a slug, breaking name addressing). So this handler is
 * only correct once that index exists: B4a (this code) MUST NOT ship without
 * B4b (the index). The best-effort `dedupeChildChannelSlug` pre-check narrows
 * the window but does NOT close it — only the index does.
 */

export type CreateForumPostInput = {
  db: Database
  /** The parent forum channel (already membership-gated + asserted type=forum by the caller). */
  forumChannelId: string
  serverId: string
  /** The post creator (human userId or bot userId). */
  authorId: string
  /** Raw, pre-slugify title — its slug becomes the post's addressing name; the
   *  original is captured verbatim into `display_title`. */
  rawTitle: string
  /** Post body text (may be empty when attachments carry the content). */
  content: string
  mentionType?: unknown
  /**
   * Pending attachment ids, validated by the caller against (uploader, target).
   * Reserve-by-id is the single attachment path for BOTH callers (human forum
   * route + bot createPost), route/disc step 2b — there is no url-carried
   * attachment payload anymore.
   */
  attachmentIds?: string[]
  clientNonce?: string
}

// The success shape of createCommunityMessage — narrowed to its `ok:true` arm so
// we can reuse its exact `row`/`attachments` types without re-declaring them.
type CreateMessageSuccess = Extract<Awaited<ReturnType<typeof createCommunityMessage>>, { ok: true }>

type CreatedChannel = Awaited<ReturnType<typeof queries.communityChannel.createChannel>>

export type CreateForumPostResult =
  | { ok: true; postChannel: CreatedChannel; messageRow: CreateMessageSuccess["row"]; attachments: CreateMessageSuccess["attachments"] }
  | { ok: false; status: 400 | 409; error: string }

// How many times to re-bump a colliding slug before giving up. A forum with
// this many same-titled posts racing at once is pathological; the cap stops an
// unbounded loop if something (e.g. a missing index in a mis-shipped B4a) makes
// every insert collide.
const MAX_SLUG_BUMP_ATTEMPTS = 8

/**
 * Validate + create a forum post. Returns a structured error (never throws) for
 * the caller to translate into its surface's response shape. Does NOT do the
 * WS/fanout side effects beyond what `createCommunityMessage` fires — the caller
 * owns its own CHILD_CHANNEL_CREATE emission + response projection.
 */
export async function createForumPost(input: CreateForumPostInput): Promise<CreateForumPostResult> {
  const { db, forumChannelId, serverId, authorId, rawTitle, content } = input

  // ── validation (shared by both callers) ──────────────────────────────────
  const trimmedTitle = rawTitle.trim()
  if (trimmedTitle.length === 0) return { ok: false, status: 400, error: "title is required" }
  if (trimmedTitle.length > MAX_CHANNEL_NAME_LENGTH) {
    return { ok: false, status: 400, error: `title must be 1-${MAX_CHANNEL_NAME_LENGTH} characters` }
  }
  const baseSlug = slugify(trimmedTitle)
  if (!baseSlug) return { ok: false, status: 400, error: "title must contain at least one addressable character" }

  const hasContent = content.trim().length > 0
  const hasAttachments = Array.isArray(input.attachmentIds) && input.attachmentIds.length > 0
  // opener-body contract (thread consensus): a post needs text OR an attachment
  // — an attachment-only post is legitimate (the attachment is its body).
  if (!hasContent && !hasAttachments) return { ok: false, status: 400, error: "post is empty" }
  if (hasContent && content.length > MAX_MESSAGE_CONTENT_LENGTH) {
    return { ok: false, status: 400, error: `content must be ≤ ${MAX_MESSAGE_CONTENT_LENGTH} characters` }
  }

  // ── collision handling via the shared trait-keyed strategy (B4 convergence) ──
  // forum_post's creation trait is pure-create → createWithCollisionPolicy runs
  // the bump-retry loop: each `attempt` re-derives a deduped slug and inserts;
  // a concurrent unique-constraint collision re-bumps (never re-selects a
  // winner — that's get-or-create). The SAME dispatch serves thread-create
  // (get-or-create) and top-level create (reject-on-collision); only this
  // callback (the forum_post channel-shape) is post-specific.
  const channelResult = await createWithCollisionPolicy<CreatedChannel>(channelCreation("forum_post"), {
    maxAttempts: MAX_SLUG_BUMP_ATTEMPTS,
    attempt: async () => {
      // Best-effort snapshot dedupe narrows the collision window; the partial
      // unique index (B4b) is what actually guarantees uniqueness under a race,
      // and is what makes this insert throw so the policy re-bumps. Re-run per
      // attempt against the now-updated table.
      const candidateSlug = await queries.communityChannel.dedupeChildChannelSlug(db, forumChannelId, baseSlug)
      return queries.communityChannel.createChannel(db, {
        serverId,
        parentChannelId: forumChannelId,
        name: candidateSlug,
        type: "forum_post",
        creatorId: authorId,
        // Display-only original title, captured BEFORE slugify (B0 decision, now
        // persisted in B4b's display_title column). `trimmedTitle` is the raw
        // human input ("Q3 planning / roadmap"), NOT the lossy slug — the point
        // is preserving what slugify destroys. Never an addressing axis.
        displayTitle: trimmedTitle,
      })
    },
  })
  if (!channelResult.ok) return channelResult
  const postChannel = channelResult.value

  // First message = the post body, routed kind:"forum_post" so notify-set enroll
  // runs (creator "spoke" + @-mentioned "mention"), matching a thread.
  // skipChildChannelUpdate: the caller emits its own CHILD_CHANNEL_CREATE.
  const created = await createCommunityMessage({
    db,
    authorId,
    target: { kind: "forum_post", channelId: postChannel.id, parentChannelId: forumChannelId, serverId },
    body: { content, mentionType: input.mentionType },
    attachmentIds: input.attachmentIds,
    clientNonce: input.clientNonce,
    skipChildChannelUpdate: true,
  })
  if (!created.ok) {
    // First-message failed — the post channel exists but has no body. Surface
    // the error. NOTE: full orphan-avoidance (folding channel + first-message
    // into ONE atomic batch) is a tracked hardening follow-up (Ingaborg's owed
    // work), NOT B4a — createCommunityMessage claims a seq in its own statement
    // so it can't fuse into the createChannel insert without the batch rework.
    // Non-regression: the human New-Post route has this same window today.
    return { ok: false, status: created.status, error: created.error }
  }

  return {
    ok: true,
    postChannel,
    messageRow: created.row,
    attachments: created.attachments,
  }
}
