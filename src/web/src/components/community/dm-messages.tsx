import { Avatar } from "./avatar"
import { DateDivider } from "./dividers"
import { Message } from "./message"
import { dateKey, formatDateLabel } from "./format-time"
import type { DM, OpenProfile } from "./_types"

// DM conversation message stream.
export function DmMessages({ dm, onOpenProfile }: { dm: DM; onOpenProfile?: OpenProfile }) {
  return (
    <div className="flex-1 overflow-y-auto thin-scrollbar">
      <div className="flex min-h-full flex-col justify-end gap-4 px-4 py-5">
        <div className="mb-2">
          <div className="relative mb-3 w-fit">
            <Avatar label={dm.avatar} size={68} />
          </div>
          <h2 className="text-2xl font-semibold leading-tight">{dm.name}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            This is the beginning of your direct message history with <span className="font-medium text-foreground">{dm.name}</span>.
          </p>
        </div>
        {dm.messages.map((m, i) => {
          const prev = i > 0 ? dm.messages[i - 1] : null
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
