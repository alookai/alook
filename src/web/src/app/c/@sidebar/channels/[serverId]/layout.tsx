import type { ReactNode } from "react"
import { ServerSidebarSlot } from "@/components/community/shell/server-sidebar-slot"

export default async function ServerSidebarLayout({ children, params }: {
  children: ReactNode
  params: Promise<{ serverId: string }>
}) {
  const { serverId } = await params
  return <><ServerSidebarSlot serverId={serverId} />{children}</>
}
