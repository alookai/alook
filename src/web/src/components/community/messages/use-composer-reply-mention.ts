import { useEffect, useRef } from "react"
import type { Editor } from "@tiptap/react"
import { formatHandle } from "@alook/shared"
import { useCanonicalCommunityIdentity, useCanonicalProfileLookup } from "@/lib/community-db/projections"
import type { Member } from "@/lib/community/models/people"
import type { ComposerProps, ComposerReplyTarget } from "./composer-types"
import { prependReplyMention } from "./prepend-reply-mention"
import { useConversationActivity } from "@/contexts/view-activity"

export function useComposerReplyMention({
  editor, channelType, isForumThreadBody, replyingTo, members, suppressSuggestions,
}: {
  editor: Editor | null
  channelType?: ComposerProps["channelType"]
  isForumThreadBody: boolean
  replyingTo?: ComposerReplyTarget
  members: Member[]
  suppressSuggestions: (operation: () => void) => void
}) {
  const active = useConversationActivity()
  const needsReplyLookup = active && !!replyingTo && !isForumThreadBody && channelType !== "dm"
  const authorProfile = useCanonicalCommunityIdentity(needsReplyLookup ? replyingTo?.authorId : null)
  const hasCanonicalProfile = useCanonicalProfileLookup()
  const previousReplyingToRef = useRef<ComposerReplyTarget | undefined>(undefined)
  useEffect(() => {
    if (!replyingTo) {
      previousReplyingToRef.current = undefined
      return
    }
    if (!active) return
    if (previousReplyingToRef.current === replyingTo || !editor || isForumThreadBody) return
    if (channelType !== "dm") {
      const authorId = replyingTo.authorId
      if (authorId && (!authorProfile?.name || !authorProfile.discriminator)) {
        suppressSuggestions(() => editor.commands.focus("end"))
        return
      }
      if (authorId && authorProfile?.name && authorProfile.discriminator) {
        prependReplyMention(editor, {
          id: authorId,
          label: formatHandle(authorProfile.name, authorProfile.discriminator),
        }, [authorId, ...members.filter((member) => member.userId === authorId).map((member) => member.id)],
        (id) => id === authorId || hasCanonicalProfile(id) ? id : members.find((member) => member.id === id)?.userId)
      }
    }
    previousReplyingToRef.current = replyingTo
    suppressSuggestions(() => editor.commands.focus("end"))
  }, [active, replyingTo, authorProfile, hasCanonicalProfile, members, editor, channelType, isForumThreadBody, suppressSuggestions])
}
