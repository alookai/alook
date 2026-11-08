"use client"

import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"

import { useState, type CSSProperties, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { UserSettings } from "@/components/community/settings/user-settings"
import { useServerSettingsEditor } from "@/components/community/settings/server-settings-editor"
import { ServerSettings } from "@/components/community/settings/server-settings"
import { CategorySettingsDialog } from "@/components/community/settings/category-settings-dialog"
import { CreateCategoryDialog } from "@/components/community/settings/create-category-dialog"
import { CreateServerDialog } from "@/components/community/settings/create-server-dialog"
import type { SettingsSection } from "@/components/community/settings/settings-types"
import type { Member } from "@/lib/community/models/people"
import { DEMO_CHANNELS, DEMO_PROFILES, DEMO_SERVERS } from "@/components/home/landing-interactive-shell-data"
import { Fixtures, Specimen } from "./app-components"
import s from "./brand-visual.module.css"

const noop = () => {}
const ME = DEMO_PROFILES.get("demo-gus")
const SERVER = DEMO_SERVERS[0]
const CATEGORY = (DEMO_CHANNELS[SERVER?.id ?? ""] ?? []).find((c) => c.private) ?? DEMO_CHANNELS[SERVER?.id ?? ""]?.[0]
const MEMBERS: Member[] = [...DEMO_PROFILES.values()].map((p) => ({
  id: p.id, userId: p.id, name: p.name ?? p.id, avatar: p.avatar ?? "", avatarVersion: 0, discriminator: p.discriminator ?? "",
  status: p.presence ?? "online", sub: p.aboutMe ?? "", role: p.id === "demo-gus" ? "owner" : "member",
}))

const SETTINGS_DIALOG_CLASS = "flex h-full max-h-full w-full max-w-none flex-col gap-0 overflow-hidden rounded-none p-0 sm:h-[calc(100%-4rem)] sm:max-h-180 sm:w-[calc(100%-4rem)] sm:max-w-4xl sm:rounded-xl"

const INLINE_FRAME: CSSProperties = { display: "flex", flexDirection: "column", height: 640, overflow: "hidden", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--background)" }

function UserSettingsDemo({ onClose }: { onClose: () => void }) {
  return (
    <UserSettings
      onClose={onClose}
      userId={ME?.id ?? "demo-gus"}
      userName={ME?.name ?? "Gus"}
      userEmail="gus@example.com"
      aboutMe={ME?.aboutMe ?? ""}
      avatar={ME?.avatar ?? ""}
      statusEmoji="🎨"
      statusText="Reviewing the board"
      onSave={noop}
      onLogout={noop}
      onAccountDeleted={async () => {}}
      onUploadAvatar={noop}
    />
  )
}

function ServerSettingsDemo({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>("overview")
  const feedback = useCommunityViewSource("server-settings-demo")
  const editor = useServerSettingsEditor({ serverId: SERVER?.id ?? "demo-studio", name: SERVER?.name ?? "Alook",
    desc: "Where people and agents build Alook together.", open: true, onSave: noop })
  return (
    <ServerSettings
      isAdmin
      section={section}
      setSection={setSection}
      onClose={onClose}
      serverId={SERVER?.id ?? "demo-studio"}
      serverName={SERVER?.name ?? "Alook"}
      serverIcon={SERVER?.icon ?? null}
      members={MEMBERS}
      membersTotal={MEMBERS.length}
      onLoadMoreMembers={noop}
      onSearchMembers={noop}
      onKickMember={noop}
      onSetRole={noop}
      onRevokeInvite={noop}
      onCopyInvite={noop}
      onDeleteServer={noop}
      onUploadIcon={noop}
      editor={editor}
      captureSaveFeedback={feedback.capture}
      notifLevel="Only @mentions"
      onSetNotifLevel={noop}
    />
  )
}

function SettingsDialog({ open, onOpenChange, title, children }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SETTINGS_DIALOG_CLASS} showCloseButton={false}>
        <DialogTitle className="sr-only">{title}</DialogTitle>
        {children}
      </DialogContent>
    </Dialog>
  )
}

type Open = null | "user" | "server" | "category" | "newCategory" | "newServer"

export function AppSettingsSpecimens({ accountId }: { mode: "light" | "dark"; accountId?: string }) {
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)
  const toggle = (k: Exclude<Open, null>) => setOpen((cur) => (cur === k ? null : k))
  return (
    <Fixtures accountId={accountId}>
      <div style={{ display: "grid", gap: 24 }}>
        <Specimen label="Open as dialogs" note="Real app modals, mounted only on press. Data calls fail without a backend; saves are no-ops.">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, padding: 16 }}>
            <Button variant="outline" size="sm" onClick={() => toggle("user")}>Open user settings</Button>
            <Button variant="outline" size="sm" onClick={() => toggle("server")}>Open server settings</Button>
            <Button variant="outline" size="sm" onClick={() => toggle("category")}>Open category settings</Button>
            <Button variant="outline" size="sm" onClick={() => toggle("newCategory")}>Open new category</Button>
            <Button variant="outline" size="sm" onClick={() => toggle("newServer")}>Open create server</Button>
          </div>
        </Specimen>
        <div className={s.grid2}>
          <Specimen label="UserSettings" note="Inline in the dialog frame. Click a tab on the left.">
            <div style={INLINE_FRAME}><UserSettingsDemo onClose={noop} /></div>
          </Specimen>
          <Specimen label="ServerSettings" note="Inline, admin view. Click a tab on the left.">
            <div style={INLINE_FRAME}><ServerSettingsDemo onClose={noop} /></div>
          </Specimen>
        </div>
      </div>

      <SettingsDialog open={open === "user"} onOpenChange={(o) => { if (!o) close() }} title="User settings">
        <UserSettingsDemo onClose={close} />
      </SettingsDialog>
      <SettingsDialog open={open === "server"} onOpenChange={(o) => { if (!o) close() }} title="Server settings">
        <ServerSettingsDemo onClose={close} />
      </SettingsDialog>
      {open === "category" && <CategorySettingsDialog name={CATEGORY?.name ?? "PUBLIC"} isPrivate={Boolean(CATEGORY?.private ?? true)} onClose={close} onSave={noop} />}
      {open === "newCategory" && <CreateCategoryDialog onClose={close} onCreate={noop} />}
      {open === "newServer" && <CreateServerDialog onClose={close} onCreateServer={noop} />}
    </Fixtures>
  )
}
