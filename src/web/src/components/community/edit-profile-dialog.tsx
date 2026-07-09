"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { User, LogOut, X, Palette, Sun, Moon, Monitor, Database } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { clearPersistedCache } from "@/lib/query-persister"
import { Field } from "./field"

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)
  useEffect(() => setMounted(true), [])
  const active = mounted ? theme ?? "system" : undefined

  return (
    <div className="max-w-xl space-y-4">
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
            await clearPersistedCache(userId)
            toast("Local cache cleared — reloading")
            // Hard reload so the QueryClient starts fresh without racing an
            // in-flight persister write.
            window.location.reload()
          } catch {
            toast("Failed to clear cache")
            setClearing(false)
            setConfirmOpen(false)
          }
        }}
      />
      <div className="max-w-xl space-y-6">
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

export function UserSettings({ onClose, userId, userName, aboutMe, onSave, onLogout }: {
  onClose: () => void
  userId: string | null
  userName: string
  aboutMe: string
  onSave: (data: { name?: string; aboutMe?: string }) => void
  onLogout?: () => void
}) {
  const [name, setName] = useState(userName)
  const [value, setValue] = useState(aboutMe)
  const [saving, setSaving] = useState(false)
  const [tab, setTab] = useState("profile")
  const timerRef = useRef<NodeJS.Timeout | null>(null)
  const onSaveRef = useRef(onSave)
  useEffect(() => {
    onSaveRef.current = onSave
  }, [onSave])

  const debouncedSave = useCallback((data: { name?: string; aboutMe?: string }) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setSaving(true)
      onSaveRef.current(data)
      setTimeout(() => setSaving(false), 600)
    }, 800)
  }, [])

  useEffect(() => { return () => { if (timerRef.current) clearTimeout(timerRef.current) } }, [])

  const handleAboutMeChange = (text: string) => {
    setValue(text)
    debouncedSave({ aboutMe: text.trim() })
  }

  const handleNameChange = (text: string) => {
    setName(text)
    debouncedSave({ name: text.trim() })
  }

  return (
    <Tabs
      orientation="vertical"
      value={tab}
      onValueChange={setTab}
      className="min-h-0 flex-1 flex-row gap-0"
    >
      <nav className="flex w-60 shrink-0 flex-col gap-2 overflow-y-auto thin-scrollbar border-r border-border p-3" style={{ background: "var(--d-rail)" }}>
        <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">User Settings</div>
        <TabsList variant="line" className="h-auto w-full flex-col gap-1">
          <TabsTrigger value="profile" className="h-8 w-full justify-start gap-2">
            <User className="size-4" /> My Profile
          </TabsTrigger>
          <TabsTrigger value="appearance" className="h-8 w-full justify-start gap-2">
            <Palette className="size-4" /> Appearance
          </TabsTrigger>
          <TabsTrigger value="advanced" className="h-8 w-full justify-start gap-2">
            <Database className="size-4" /> Advanced
          </TabsTrigger>
        </TabsList>
        <Separator className="my-1" />
        <Button variant="ghost" className="justify-start text-destructive hover:text-destructive" size="sm" onClick={onLogout}>
          <LogOut className="size-4" /> Log Out
        </Button>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col bg-background">
        <header className="flex h-12 shrink-0 items-center border-b border-border px-4">
          <h1 className="flex-1 text-lg font-semibold">
            {tab === "appearance" ? "Appearance" : tab === "advanced" ? "Advanced" : "My Profile"}
          </h1>
          <button onClick={onClose} className="flex flex-col items-center text-muted-foreground hover:text-foreground" aria-label="Close settings">
            <span className="grid size-8 place-items-center rounded-full border border-current"><X className="size-4" /></span>
          </button>
        </header>
        <div className="flex-1 overflow-y-auto thin-scrollbar p-4">
          <TabsContent value="profile">
            <div className="max-w-xl space-y-4">
              <Field label={<span>Display Name {saving && <span className="ml-2 text-xs text-muted-foreground">Saving...</span>}</span>}>
                <Input value={name} onChange={(e) => handleNameChange(e.target.value)} />
              </Field>
              <Field label="About Me">
                <Textarea className="h-24 resize-none" value={value} onChange={(e) => handleAboutMeChange(e.target.value)} />
              </Field>
            </div>
          </TabsContent>
          <TabsContent value="appearance">
            <AppearanceSettings />
          </TabsContent>
          <TabsContent value="advanced">
            <AdvancedSettings userId={userId} />
          </TabsContent>
        </div>
      </div>
    </Tabs>
  )
}
