"use client"

import { useBotListController } from "./bot-list-controller"
import { renderBotListView } from "./bot-list-view"
import type { BotListProps } from "./bot-list-types"

export function BotList({ onBack }: BotListProps = {}) {
  const controller = useBotListController()
  return renderBotListView({ onBack }, controller)
}
