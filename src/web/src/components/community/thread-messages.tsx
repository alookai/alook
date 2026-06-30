import { MessagesSquare } from "lucide-react"
import { DateDivider } from "./dividers"
import { Message } from "./message"
import { dateKey, formatDateLabel } from "./format-time"
import type { Thread, OpenProfile } from "./_types"

// Thread message stream (takes over the message area like a channel).
export function ThreadMessages({ thread, onOpenProfile }: { thread: Thread; onOpenProfile?: OpenProfile }) {
  return (
    <div className="flex-1 overflow-y-auto thin-scrollbar">
      <div className="flex min-h-full flex-col justify-end px-4 py-5">
        {/* thread hero — mirrors the channel welcome */}
        <div className="mb-4">
          <div className="mb-3 grid size-17 place-items-center rounded-full bg-muted">
            <MessagesSquare className="size-8 text-muted-foreground" />
          </div>
          <h2 className="text-2xl font-semibold leading-tight">{thread.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Started by <span className="font-medium text-foreground">{thread.parent.authorName}</span>
          </p>
        </div>

        {thread.messages.map((m, i) => {
          const prev = i > 0 ? thread.messages[i - 1] : null
          const prevDate = prev ? dateKey(prev.createdAt) : ""
          const curDate = dateKey(m.createdAt)
          const showDateDivider = curDate && curDate !== prevDate
          const grouped = !!(prev && !m.type && !m.replyTo && prev.authorName === m.authorName
            && prev.createdAt && m.createdAt && (new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 420_000)
          return (
            <div key={m.id}>
              {showDateDivider && <DateDivider label={formatDateLabel(m.createdAt!)} />}
              <Message m={{ ...m, grouped }} onOpenThread={() => {}} onOpenProfile={onOpenProfile} />
            </div>
          )
        })}
      </div>
    </div>
  )
}
