import { OfficialServerBadge } from "../official-server-badge"
import { ServerIcon } from "@/components/community/server-icon"
import type { Server } from "@/lib/community/models/navigation"

export function RailServerIcon({ server, active }: { server: Server; active?: boolean }) {
  return <>
    <ServerIcon data-rail-drag-preview id={server.id} name={server.name} initial={server.initial} icon={server.icon} size={40}
      className={[
        "pointer-events-none relative grid size-10 place-items-center overflow-hidden font-brand text-xl font-bold transition-all duration-150",
        active ? "cursor-default rounded-xl" : "cursor-pointer rounded-[18px] group-hover/server:rounded-xl",
        server.icon
          ? active ? "bg-primary text-primary-foreground" : "bg-card group-hover/server:bg-primary group-hover/server:text-primary-foreground"
          : "text-white [text-shadow:0_1px_2px_rgb(0_0_0/0.35)] group-hover/server:brightness-110",
      ].join(" ")} />
    <OfficialServerBadge official={server.official} className="absolute -left-1 -top-1 z-2" />
  </>
}
