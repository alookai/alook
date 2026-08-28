"use client"

import { useCallback, useMemo, useRef } from "react"
import { formatHandle } from "@alook/shared"
import type { Member } from "@/lib/community/models/people"
import type { ComposerHandle } from "./composer"

type MentionIdentity = Pick<Member, "userId" | "name" | "discriminator">

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
  const mentionTextByUserId = useMemo(() => {
    const identities: MentionIdentity[] = [...members]
    if (viewerDiscriminator) {
      identities.push({
        userId: viewerUserId,
        name: viewerName,
        discriminator: viewerDiscriminator,
      })
    }
    return new Map(identities.map((identity) => [
      identity.userId,
      canonicalAuthorMentionText(identity),
    ]))
  }, [members, viewerDiscriminator, viewerName, viewerUserId])
  const resolveAuthorMentionText = useCallback(
    (authorId: string) => mentionTextByUserId.get(authorId) ?? null,
    [mentionTextByUserId],
  )
  const insertMentionText = useCallback((text: string) => {
    composerRef.current?.insertTextAtCaret(text)
  }, [])

  return { composerRef, resolveAuthorMentionText, insertMentionText }
}
