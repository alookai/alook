"use client"

import { useState } from "react"
import { Inbox } from "lucide-react"
import { NumberTicker } from "@/components/ui/number-ticker"
import styles from "./inbox-unread-indicator.module.css"

export function InboxUnreadIndicator({ count, partial = false, open, descriptionId }: {
  count: number
  partial?: boolean
  open: boolean
  descriptionId?: string
}) {
  const [lastCount, setLastCount] = useState(count)
  if (count > 0 && count !== lastCount) setLastCount(count)
  const displayCount = count > 0 ? count : lastCount
  const overflow = displayCount > 99 || partial
  return (
    <>
      <span id={descriptionId} className="sr-only">{count > 0 ? `${count}${partial ? "+" : ""} unread conversations or requests` : "No unread items"}</span>
      <span className={styles.indicator} data-unread={count > 0 && !open} data-count={count} data-partial={partial} aria-hidden="true" data-slot="inbox-unread-indicator">
        <span className={styles.circle} data-slot="inbox-unread-circle">
          {overflow ? <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" data-slot="inbox-unread-ellipsis"><circle cx="3" cy="8" r="1.5" /><circle cx="8" cy="8" r="1.5" /><circle cx="13" cy="8" r="1.5" /></svg> : <NumberTicker value={displayCount} duration={220} />}
        </span>
        <span className={styles.icon}><Inbox className="size-4" /></span>
      </span>
    </>
  )
}
