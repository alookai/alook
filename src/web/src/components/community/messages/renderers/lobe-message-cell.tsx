"use client"

import ChatItem from "@lobehub/ui/es/chat/ChatItem/ChatItem"
import { ThemeScope } from "@lobehub/ui/es/styles/theme/scope"
import "@lobehub/ui/style.css"
import { memo } from "react"
import { useTheme } from "next-themes"
import type { MessageCellPresentationProps } from "./message-cell-types"
import { MessageCellLayout } from "./message-cell-layout"
import styles from "./lobe-message-cell.module.css"

export const LobeMessageCell = memo(function LobeMessageCell({
  message, authorName, compact, grouped, selected, highlighted, slots,
}: MessageCellPresentationProps) {
  const { resolvedTheme } = useTheme()
  return <ThemeScope appearance={resolvedTheme === "dark" ? "dark" : "light"} className={styles.scope}>
    <div
      className={styles.frame}
      data-lobe-message-cell={message.id}
      data-compact={compact}
      data-grouped={grouped}
      data-selected={selected}
      data-highlighted={highlighted}
    >
      <MessageCellLayout renderer="lobe" slots={slots}>
        <ChatItem
          className={styles.cell}
          variant="docs"
          placement="left"
          direction="vertical"
          align="stretch"
          gap={8}
          padding={0}
          avatar={{ title: authorName }}
          showAvatar={false}
          showTitle={false}
          message={message.content ?? ""}
          renderMessage={() => slots.content}
          aboveMessage={slots.header}
          belowMessage={slots.footer}
        />
      </MessageCellLayout>
    </div>
  </ThemeScope>
})
