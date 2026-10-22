"use client"

import { lazy, memo, Suspense } from "react"
import { cjk } from "@streamdown/cjk"
import { useCommunityPreviewNavigation } from "@/components/community/shell/community-preview-navigation"
import type { OpenProfile } from "../social/profile-types"
import type { MessagePerspective } from "./message-presentation-types"
import { MessageBodyView } from "./message-body-view"

export type MessageBodyProps = {
  text: string
  onOpenProfile?: OpenProfile
  perspective?: MessagePerspective
}

const FullMessageBody = lazy(() => import("./message-body-full"))

export const MessageBody = memo(function MessageBody(props: MessageBodyProps) {
  const preview = useCommunityPreviewNavigation()
  const body = <MessageBodyView {...props} plugins={{ cjk }} />
  return preview ? body : <Suspense fallback={body}><FullMessageBody {...props} /></Suspense>
})
