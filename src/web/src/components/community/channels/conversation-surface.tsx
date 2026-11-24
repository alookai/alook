"use client"

import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import { MessageList } from "@/components/community/messages/message-list"
import {
  ConversationFooterShell,
  ConversationFooterSlotProvider,
} from "@/components/community/messages/conversation-footer-shell"
import { ConversationActivityContext } from "@/contexts/view-activity"
import { tid } from "@/lib/community/testids"

type ConversationSurfaceSubtype = "dm" | "text" | "thread"

type ConversationFooterAttributes = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  [key: `data-${string}`]: string | boolean | undefined
}

export function ConversationSurface({
  channelId,
  subtype,
  embedded = false,
  loadingPending = false,
  loadingPendingLabel,
  header,
  bodyOverride,
  messageListProps,
  footer,
  footerProps,
  inputActive,
  sidePanel,
  dialogs,
}: {
  channelId: string
  subtype?: ConversationSurfaceSubtype
  embedded?: boolean
  loadingPending?: boolean
  loadingPendingLabel?: string
  header: ReactNode
  bodyOverride?: ReactNode
  messageListProps?: Omit<ComponentProps<typeof MessageList>, "channelId">
  footer: ReactNode
  footerProps?: ConversationFooterAttributes
  inputActive?: boolean
  sidePanel?: ReactNode
  dialogs?: ReactNode
}) {
  const Body = embedded ? "div" : "main"

  return (
    <>
      {header}
      <Body
        data-slot="community-conversation-surface"
        data-channel-id={channelId}
        data-testid={!embedded && loadingPending ? tid.conversationResolutionPending : undefined}
        aria-busy={!embedded && loadingPending ? true : undefined}
        aria-label={!embedded && loadingPending ? loadingPendingLabel : undefined}
        data-community-conversation-subtype={subtype && subtype !== "dm" ? subtype : undefined}
        className="flex min-h-0 min-w-0 flex-1 flex-col"
      >
        <ConversationFooterSlotProvider>
          {bodyOverride !== undefined
            ? bodyOverride
            : messageListProps
              ? <MessageList key={channelId} channelId={channelId} {...messageListProps} />
              : null}
          <ConversationFooterShell {...footerProps}>
            {inputActive !== undefined
              ? (
                  <ConversationActivityContext value={inputActive}>
                    {footer}
                  </ConversationActivityContext>
                )
              : footer}
          </ConversationFooterShell>
        </ConversationFooterSlotProvider>
      </Body>
      {sidePanel}
      {dialogs}
    </>
  )
}
