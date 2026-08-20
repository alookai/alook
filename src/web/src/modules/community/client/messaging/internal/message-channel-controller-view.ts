import type { ReactNode } from "react"
import type { MessageChannelControllerValue } from "./message-channel-controller-types"

export function renderMessageChannelController(
  children: (controller: MessageChannelControllerValue) => ReactNode,
  value: MessageChannelControllerValue,
) {
  return children(value)
}
