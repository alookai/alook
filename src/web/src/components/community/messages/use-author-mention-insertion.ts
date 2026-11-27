"use client"

import { useCallback, useMemo, useRef } from "react"
import { formatHandle } from "@alook/shared"
import type { Member } from "@/lib/community/models/people"
import { useLatestRef } from "@/hooks/community/use-latest-ref"
import type { ComposerHandle, ComposerMention } from "./composer"

type MentionIdentity = Pick<Member, "id" | "userId" | "name" | "discriminator">

function buildMentionIdentityKey(
  members: readonly MentionIdentity[],
  viewerUserId: string,
  viewerName: string,
  viewerDiscriminator?: string,
): string {
  let key = `${viewerUserId}\0${viewerName}\0${viewerDiscriminator ?? ""}`
  for (const member of members) {
    key += `\x01${member.userId}\0${member.name}\0${member.discriminator ?? ""}`
  }
  return key
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
  const identityKey = buildMentionIdentityKey(members, viewerUserId, viewerName, viewerDiscriminator)
  const mentionMaps = useMemo(() => {
    const byUserId = new Map<string, ComposerMention>()
    const byText = new Map<string, ComposerMention>()
    const add = (userId: string, name: string, discriminator?: string) => {
      if (byUserId.has(userId)) return
      const mention: ComposerMention = {
        id: userId,
        label: discriminator ? formatHandle(name, discriminator) : name,
      }
      byUserId.set(userId, mention)
      const text = `@${mention.label}`
      if (!byText.has(text)) byText.set(text, mention)
    }
    const entries = identityKey.split("\x01")
    for (let i = 1; i < entries.length; i++) {
      const part = entries[i]!
      const first = part.indexOf("\0")
      const second = part.indexOf("\0", first + 1)
      if (first < 0 || second < 0) continue
      const userId = part.slice(0, first)
      const name = part.slice(first + 1, second)
      const discriminator = part.slice(second + 1) || undefined
      add(userId, name, discriminator)
    }
    const viewerPart = entries[0] ?? ""
    const vFirst = viewerPart.indexOf("\0")
    const vSecond = viewerPart.indexOf("\0", vFirst + 1)
    if (vFirst >= 0 && vSecond >= 0) {
      const vId = viewerPart.slice(0, vFirst)
      const vName = viewerPart.slice(vFirst + 1, vSecond)
      const vDisc = viewerPart.slice(vSecond + 1) || undefined
      if (vDisc) add(vId, vName, vDisc)
    }
    return { byUserId, byText }
  }, [identityKey])

  const mentionMapsRef = useLatestRef(mentionMaps)

  const resolveAuthorMentionText = useCallback(
    (authorId: string) => {
      const mention = mentionMaps.byUserId.get(authorId)
      return mention ? `@${mention.label}` : null
    },
    [mentionMaps],
  )
  const insertMentionText = useCallback((text: string) => {
    const mention = mentionMapsRef.current.byText.get(text)
    if (mention) composerRef.current?.insertMentionAtCaret(mention)
  }, [mentionMapsRef])

  return { composerRef, resolveAuthorMentionText, insertMentionText }
}
