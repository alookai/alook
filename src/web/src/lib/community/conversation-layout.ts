import { MESSAGE_ROW_VERTICAL_PADDING_PX, type FlatItem } from "./message-list-items"

export const CONVERSATION_TAIL_SPACE_PX = 40
export const COMPOSER_ACCESSORY_ROW_HEIGHT_PX = 32
export const MESSAGE_RAIL_TAIL_PADDING_END_PX = CONVERSATION_TAIL_SPACE_PX - MESSAGE_ROW_VERTICAL_PADDING_PX

export function messageRailTailPaddingEnd(lastItem: FlatItem | undefined, capsuleHeight: number): number {
  const rowPadding = lastItem?.kind === "message" ? lastItem.paddingBottom ?? MESSAGE_ROW_VERTICAL_PADDING_PX : 0
  return Math.max(0, capsuleHeight - rowPadding)
}
