import type { ComponentProps, ReactNode } from "react"
import type { RenderMsg } from "@/lib/community/models/message"
import { MessageRow, TypingIndicator } from "../messaging"
import { ChannelHeader } from "./channel-header"

export type ChannelPreviewMessage = {
  message: RenderMsg
  target?: string
  targetClassName?: string
}

export type ChannelPreviewProps = {
  channel?: string
  server?: { id: string; name: string; icon: string | null }
  onBack?: ComponentProps<typeof ChannelHeader>["onBack"]
  headerProps?: Omit<ComponentProps<typeof ChannelHeader>, "channel" | "rightPanel" | "onToggle" | "server" | "onBack">
  header?: ReactNode
  messages: readonly ChannelPreviewMessage[]
  visibleMessages?: number
  contentClassName?: string
  messageListClassName?: string
  messageSlotClassName?: string
  typingNames?: string[]
  footer?: ReactNode
}

export function ChannelPreview({
  channel,
  server,
  onBack,
  headerProps,
  header,
  messages,
  visibleMessages = messages.length,
  contentClassName = "relative flex-1 overflow-hidden px-4 py-3",
  messageListClassName,
  messageSlotClassName,
  typingNames = [],
  footer,
}: ChannelPreviewProps) {
  return (
    <>
      {header ?? (channel ? (
        <ChannelHeader
          channel={channel}
          rightPanel={null}
          onToggle={() => {}}
          server={server}
          onBack={onBack}
          {...headerProps}
        />
      ) : null)}
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className={contentClassName}>
          {(() => {
            const rows = messages.map(({ message, target, targetClassName }, index) => {
              const row = <MessageRow key={message.id} m={message} hoverCapable onOpenThread={() => {}} />
              if (!messageSlotClassName && !target && !targetClassName && visibleMessages === messages.length) {
                return row
              }
              return (
                <div
                  key={message.id}
                  data-visible={index < visibleMessages}
                  className={messageSlotClassName}
                >
                  <div data-motion-target={target} className={targetClassName}>{row}</div>
                </div>
              )
            })
            return messageListClassName ? <div className={messageListClassName}>{rows}</div> : rows
          })()}
          {typingNames.length > 0 && <TypingIndicator names={typingNames} />}
        </div>
        {footer}
      </div>
    </>
  )
}
