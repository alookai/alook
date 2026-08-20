"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { toastApiError } from "@/lib/api/client"
import { User, LogOut, Palette, Sun, Moon, Monitor, Database, Camera } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { clearPersistedQueryCache } from "@/platform/client"
import { Avatar } from "../avatar"
import { Field } from "./field"
import { StatusEditor, hasStatus } from "../social/status-editor"
import {
  SETTINGS_LOGOUT_CLASS,
} from "./settings-navigation"
import { SettingsShell, SettingsShellPanel, type SettingsShellTab } from "./settings-shell"

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

const USER_SETTINGS_TABS: SettingsShellTab<"profile" | "appearance" | "advanced">[] = [
  { value: "profile", label: "My Profile", icon: User },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "advanced", label: "Advanced", icon: Database },
]

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const active = mounted ? theme ?? "system" : undefined

  return (
    <div className="mx-auto max-w-md space-y-4">
      <Field label="Theme">
        <div className="grid grid-cols-3 gap-2">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = active === value
            return (
              <button
                key={value}
                onClick={() => setTheme(value)}
                aria-pressed={selected}
                className={[
                  "flex flex-col items-center gap-2 rounded-lg border p-4 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selected
                    ? "border-primary bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
                ].join(" ")}
              >
                <Icon className="size-5" />
                {label}
              </button>
            )
          })}
        </div>
      </Field>
    </div>
  )
}

// Advanced settings — currently just a "Clear local cache" affordance. Local
// cache = the IndexedDB-persisted TanStack Query blob (message pages +
// read-state snapshots). Rare to need in normal use; useful when a bad build
// leaves the persisted state inconsistent (see 2026-07-09 fetchOlder pollution).
function AdvancedSettings({ userId }: { userId: string | null }) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  return (
    <>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(o) => { if (!o) setConfirmOpen(false) }}
        title="Clear local cache?"
        description="This removes the locally persisted messages and read-state for your account. The next channel or DM you open will refetch from the server. Your unread state on the server is unaffected."
        confirmLabel="Clear cache"
        loadingLabel="Clearing..."
        loading={clearing}
        onConfirm={async () => {
          setClearing(true)
          try {
            await clearPersistedQueryCache(userId)
            toast("Local cache cleared — reloading")
            // Hard reload so the QueryClient starts fresh without racing an
            // in-flight persister write.
            window.location.reload()
          } catch (e) {
            toastApiError(e, "Failed to clear cache")
            setClearing(false)
            setConfirmOpen(false)
          }
        }}
      />
      <div className="mx-auto max-w-md space-y-6">
        <div>
          <div className="text-sm font-medium">Clear local cache</div>
          <p className="mt-1 text-xs text-muted-foreground">
            Removes the locally persisted message history and read-state stored
            in this browser. The next channel or DM you open will refetch from
            the server. Nothing on the server is deleted.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            onClick={() => setConfirmOpen(true)}
          >
            Clear local cache
          </Button>
        </div>
      </div>
    </>
  )
}

export function UserSettings({ onClose, userId, userName, aboutMe, avatar, statusEmoji, statusText, onSave, onLogout, onUploadAvatar }: {
  onClose: () => void
  userId: string | null
  userName: string
  aboutMe: string
  avatar: string
  statusEmoji?: string | null
  statusText?: string | null
  onSave: (data: { name?: string; aboutMe?: string; statusEmoji?: string | null; statusText?: string | null }) => void
  onLogout?: () => void
  onUploadAvatar?: () => void
}) {
  // Draft + saved baseline are mount-only on purpose — a WS-driven prop change
  // (e.g. status fan-out echo) must not clobber an in-progress edit. The
  // baseline advances only on a successful save.
  const [name, setName] = useState(userName)
  const [value, setValue] = useState(aboutMe)
  const [status, setStatus] = useState({ emoji: statusEmoji ?? null, text: statusText ?? null })
  const [baseline, setBaseline] = useState({
    name: userName,
    aboutMe,
    emoji: statusEmoji ?? null,
    text: statusText ?? null,
  })
  const [tab, setTab] = useState<"profile" | "appearance" | "advanced">("profile")

  const dirty =
    name !== baseline.name ||
    value !== baseline.aboutMe ||
    status.emoji !== baseline.emoji ||
    status.text !== baseline.text

  const handleSave = () => {
    if (!dirty) return
    const trimmedName = name.trim()
    const trimmedAbout = value.trim()
    // Status is part of the unified payload so the WS-store write and
    // server-side fanOutStatusUpdate still fire (see shell-frame wiring).
    onSave({
      name: trimmedName,
      aboutMe: trimmedAbout,
      statusEmoji: status.emoji,
      statusText: status.text,
    })
    setBaseline({ name: trimmedName, aboutMe: trimmedAbout, emoji: status.emoji, text: status.text })
    setName(trimmedName)
    setValue(trimmedAbout)
  }

  const handleCancel = () => {
    setName(baseline.name)
    setValue(baseline.aboutMe)
    setStatus({ emoji: baseline.emoji, text: baseline.text })
  }

  return (
    <SettingsShell
      value={tab}
      onValueChange={setTab}
      label="User Settings"
      title={tab === "appearance" ? "Appearance" : tab === "advanced" ? "Advanced" : "My Profile"}
      tabs={USER_SETTINGS_TABS}
      onClose={onClose}
      navFooter={
        <Button variant="ghost" className={SETTINGS_LOGOUT_CLASS} size="sm" onClick={onLogout}>
          <LogOut className="size-4" /> Log Out
        </Button>
      }
    >
      <SettingsShellPanel value="profile">
        <div className="mx-auto max-w-md space-y-6">
          {/* Avatar — centered in a soft rounded frame, with a hand-rolled
              pill button beneath (matches the bot create/edit sheet; a stock
              secondary Button reads as the old square style). */}
          <div className="flex flex-col items-center gap-3">
            <span className="block size-24 overflow-hidden rounded-full ring-1 ring-border/50">
              <Avatar label={avatar} seed={userId ?? undefined} size={96} />
            </span>
            <button
              type="button"
              onClick={onUploadAvatar}
              className="flex items-center gap-1.5 rounded-full border border-border/50 px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <Camera className="size-3.5" /> Change photo
            </button>
          </div>
          {/* Display name — inline title input, borderless (name-as-heading,
              like the agent name on the bot page). */}
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Your name"
            aria-label="Display name"
            className="w-full border-0 bg-transparent px-0 py-1 text-2xl font-medium leading-[1.2] tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground/40 focus-visible:ring-0"
          />
          {/* About — borderless auto-resizing textarea. */}
          <div>
            <div className="mb-1 text-xs text-muted-foreground">About</div>
            <AutoResizeTextarea
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Add a bit about yourself…"
              className="w-full border-0 bg-transparent px-0 py-1 text-sm text-foreground shadow-none outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
            />
          </div>
          {/* Status — quiet label + a soft chip (more formed than a bare
              borderless button, still in the frameless language). */}
          <div>
            <div className="mb-1 text-xs text-muted-foreground">Status</div>
            <StatusEditor emoji={status.emoji} text={status.text} onChange={(emoji, text) => setStatus({ emoji, text })}>
              <button className="inline-flex items-center gap-1.5 rounded-full border border-border/50 px-3 py-1.5 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
                {hasStatus(status.emoji, status.text) ? (
                  <span>{status.emoji} {status.text}</span>
                ) : (
                  <span className="text-muted-foreground/60">Set a status</span>
                )}
              </button>
            </StatusEditor>
          </div>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={handleCancel} disabled={!dirty}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={!dirty}>Save changes</Button>
          </div>
        </div>
      </SettingsShellPanel>
      <SettingsShellPanel value="appearance">
        <AppearanceSettings />
      </SettingsShellPanel>
      <SettingsShellPanel value="advanced">
        <AdvancedSettings userId={userId} />
      </SettingsShellPanel>
    </SettingsShell>
  )
}
