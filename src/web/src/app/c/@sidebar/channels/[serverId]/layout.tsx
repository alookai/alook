import { ServerSidebarSlot } from "@/components/community/shell/server-sidebar-slot"

export default async function ServerSidebarLayout({ params }: {
  params: Promise<{ serverId: string }>
}) {
  const { serverId } = await params
  return <ServerSidebarSlot serverId={serverId} />
}
