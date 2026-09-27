import { UnresolvedMainSkeleton } from "../shell/unresolved-main-skeleton"
import { ChannelHeaderSkeleton } from "./channel-header"
import { ConversationMessageSkeleton } from "./conversation-message-skeleton"
import { ForumViewSkeleton } from "./forum-view"
import { ComposerSkeleton } from "../messages/composer"

/** Inert main-area placeholder used until canonical route metadata proves the subtype. */
export function ConversationResolutionPendingFrame({
  subtype = "unknown",
}: {
  subtype?: "unknown" | "text" | "forum" | "thread"
} = {}) {
  if (subtype === "forum") {
    return (
      <>
        <ChannelHeaderSkeleton kind="forum" />
        <main
          aria-busy="true"
          aria-label="Loading forum"
          data-community-conversation-subtype="forum"
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <ForumViewSkeleton />
        </main>
      </>
    )
  }
  if (subtype === "text" || subtype === "thread") {
    return (
      <>
        <ChannelHeaderSkeleton kind={subtype} />
        <main
          aria-busy="true"
          aria-label={subtype === "thread" ? "Loading thread" : "Loading conversation"}
          data-community-conversation-subtype={subtype}
          className="flex min-h-0 min-w-0 flex-1 flex-col"
        >
          <ConversationMessageSkeleton />
          <ComposerSkeleton />
        </main>
      </>
    )
  }
  return (
    <main
      aria-busy="true"
      aria-label="Resolving conversation"
      data-community-conversation-subtype="unknown"
      className="flex min-h-0 min-w-0 flex-1 flex-col"
    >
      <UnresolvedMainSkeleton />
      <span className="sr-only">Resolving conversation</span>
    </main>
  )
}
