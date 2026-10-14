import { useEffect, useRef } from "react"
import type { Editor } from "@tiptap/react"
import { formatHandle } from "@alook/shared"
import { useCanonicalProfilesByUserId } from "@/lib/community-db/projections"
import type { Member } from "@/lib/community/models/people"
import type { ComposerReplyTarget } from "./composer-types"
import { prependReplyMention } from "./prepend-reply-mention"

export function useComposerReplyMention({
  editor, isForumThreadBody, replyingTo, members, suppressSuggestions,
}: {
  editor: Editor | null
  isForumThreadBody: boolean
  replyingTo?: ComposerReplyTarget
  members: Member[]
  suppressSuggestions: (operation: () => void) => void
}) {
  const replyProfiles = useCanonicalProfilesByUserId()
  const previousReplyingToRef = useRef<ComposerReplyTarget | undefined>(undefined)
  useEffect(() => {
    if (!replyingTo) {
      previousReplyingToRef.current = undefined
      return
    }
    if (previousReplyingToRef.current === replyingTo || !editor || isForumThreadBody) return
    const authorId = replyingTo.authorId
    const profile = authorId ? replyProfiles.get(authorId) : undefined
    if (authorId && (!profile?.name || !profile.discriminator)) {
      suppressSuggestions(() => editor.commands.focus("end"))
      return
    }
    if (authorId && profile?.name && profile.discriminator) {
      prependReplyMention(editor, {
        id: authorId,
        label: formatHandle(profile.name, profile.discriminator),
      }, [authorId, ...members.filter((member) => member.userId === authorId).map((member) => member.id)],
      (id) => replyProfiles.has(id) ? id : members.find((member) => member.id === id)?.userId)
    }
    previousReplyingToRef.current = replyingTo
    suppressSuggestions(() => editor.commands.focus("end"))
  }, [replyingTo, replyProfiles, members, editor, isForumThreadBody, suppressSuggestions])
}
