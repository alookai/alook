"use client"

import { useMessageChannelController } from "./message-channel-controller-state"
import type {
  MessageChannelControllerProps,
} from "./message-channel-controller-types"

export type { MessageChannelControllerValue } from "./message-channel-controller-types"

export function MessageChannelController({
  children,
  ...props
}: MessageChannelControllerProps) {
  const value = useMessageChannelController(props)
  return children(value)
}
