"use client"

import { useCallback, useMemo, useRef } from "react"
import { formatHandle } from "@alook/shared"
import type { Member } from "@/lib/community/models/people"
import type { ComposerHandle, ComposerMention } from "./composer"

type MentionIdentity = Pick<Member, "id" | "userId" | "name" | "discriminator">

export function canonicalAuthorMentionText(
  identity: Pick<MentionIdentity, "name" | "discriminator">,
): string {
  return `@${formatHandle(identity.name, identity.discriminator)}`
}

export function useAuthorMentionInsertion({
  members,
  viewerUserId,
  viewerName,
  viewerDiscriminator,
}: {
  members: MentionIdentity[]
  viewerUserId: string
  viewerName: string
  viewerDiscriminator?: string
}) {
  const composerRef = useRef<ComposerHandle>(null)
  const mentionByUserId = useMemo(() => {
    const identities: MentionIdentity[] = [...members]
    if (viewerDiscriminator && !identities.some(({ userId }) => userId === viewerUserId)) {
      identities.push({
        id: viewerUserId,
        userId: viewerUserId,
        name: viewerName,
        discriminator: viewerDiscriminator,
      })
    }
    return new Map(identities.map((identity) => [
      identity.userId,
      {
        id: identity.id,
        label: formatHandle(identity.name, identity.discriminator),
      } satisfies ComposerMention,
    ]))
  }, [members, viewerDiscriminator, viewerName, viewerUserId])
  const resolveAuthorMentionText = useCallback(
    (authorId: string) => {
      const mention = mentionByUserId.get(authorId)
      return mention ? `@${mention.label}` : null
    },
    [mentionByUserId],
  )
  const insertMentionText = useCallback((text: string) => {
    const mention = Array.from(mentionByUserId.values()).find(
      (candidate) => `@${candidate.label}` === text,
    )
    if (mention) composerRef.current?.insertMentionAtCaret(mention)
  }, [mentionByUserId])

  return { composerRef, resolveAuthorMentionText, insertMentionText }
}
