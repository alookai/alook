"use client"

import { useMessageChannelController } from "./internal/message-channel-controller-state"
import type {
  MessageChannelControllerProps,
  MessageChannelControllerValue,
} from "./internal/message-channel-controller-types"
import { renderMessageChannelController } from "./internal/message-channel-controller-view"

export type { MessageChannelControllerValue } from "./internal/message-channel-controller-types"

type ComposerSendAttachment = import("./composer").SendAttachment
type MessageChannelControllerFacadeProps = Omit<MessageChannelControllerProps, "children"> & {
  children: (
    controller: Omit<MessageChannelControllerValue, "acceptMessage"> & {
      acceptMessage: (
        markdown: string,
        attachments?: ComposerSendAttachment[],
        mentionType?: Parameters<MessageChannelControllerValue["acceptMessage"]>[2],
      ) => boolean
    },
  ) => ReturnType<MessageChannelControllerProps["children"]>
}

export function MessageChannelController({
  children,
  ...props
}: MessageChannelControllerFacadeProps) {
  const value = useMessageChannelController(props)
  return renderMessageChannelController(children, value)
}
