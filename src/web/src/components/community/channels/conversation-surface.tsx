"use client"

import type { ComponentProps, HTMLAttributes, ReactNode } from "react"
import { MessageList } from "@/components/community/messages/message-list"
import {
  ConversationFooterShell,
  ConversationFooterSlotProvider,
} from "@/components/community/messages/conversation-footer-shell"
import { ConversationActivityContext, useConversationPresentation } from "@/contexts/view-activity"
import { useNativeKeyboard } from "@/hooks/use-native-keyboard"
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
  const keyboard = useNativeKeyboard()
  const presented = useConversationPresentation()
  const overlayGpuKeyboard = presented && keyboard?.mode === "overlay-gpu"

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
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      >
        <ConversationFooterSlotProvider reserveAccessorySlot>
          {bodyOverride !== undefined
            ? bodyOverride
            : messageListProps
              ? (
                  <div
                    data-slot="community-message-list-keyboard-layer"
                    data-alook-kb-gpu-layer={overlayGpuKeyboard ? "true" : undefined}
                    className={`flex min-h-0 min-w-0 flex-1 flex-col${overlayGpuKeyboard ? " alook-kb-gpu-layer" : ""}`}
                  >
                    <MessageList key={channelId} channelId={channelId} {...messageListProps} />
                  </div>
                )
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
