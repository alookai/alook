"use client"

import { useState } from "react"
import { useParams, useRouter } from "next/navigation"
import { toast } from "sonner"
import { useCommunity } from "@/contexts/community/context"
import { ServerSettings } from "@/components/community/server-settings"
import type { SettingsSection } from "@/components/community/_types"

/**
 * /community/channels/:serverId/settings
 *
 * Full-screen server settings page. Only accessible to admin/owner.
 * Static segment — beats [channelId] in Next.js routing.
 */
export default function ServerSettingsPage() {
  const params = useParams<{ serverId: string }>()
  const router = useRouter()
  const ctx = useCommunity()
  const [section, setSection] = useState<SettingsSection>("overview")

  const close = () => {
    router.push(`/community/channels/${params.serverId}`)
  }

  const openProfile = (_name: string, _e: React.MouseEvent) => {
    // Profile cards handled at layout level
  }

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      <ServerSettings
        section={section}
        setSection={setSection}
        onClose={close}
        serverName={ctx.currentServer?.name ?? ""}
        serverDescription={ctx.currentServer?.description ?? ""}
        members={ctx.members}
        invites={ctx.invites}
        auditLog={ctx.auditLog}
        onKickMember={(name) => {
          const member = ctx.members.find((m) => m.name === name)
          if (member) ctx.kickMember(member.id)
        }}
        onSetRole={(name, role) => {
          const member = ctx.members.find((m) => m.name === name)
          if (member) ctx.setMemberRole(member.id, role)
        }}
        onRevokeInvite={(code) => ctx.revokeInvite(code)}
        onCreateInvite={() => ctx.createInvite()}
        onCopyInvite={(code) => { navigator.clipboard?.writeText(`${window.location.origin}/community/invite/${code}`); toast("Invite copied") }}
        onDeleteServer={() => { toast("Server deleted"); close() }}
        onUploadIcon={() => toast("Upload a server icon")}
        onUpdateServer={(name, desc) => ctx.updateServer(name, desc)}
        notifLevel={ctx.notifLevel}
        onSetNotifLevel={ctx.setNotifLevel}
        onOpenProfile={openProfile}
      />
    </div>
  )
}
