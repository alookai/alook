"use client"

import { useObservedRegion } from "@/lib/observability/regions"
import { useObservedQueryRegion } from "@/lib/observability/query-regions"

import { useAtom, useCreateAtom, useCreateStore } from "@tanstack/react-store";
import { useEffect, useLayoutEffect } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { toastApiError } from "@/lib/api/client"
import { User, LogOut, Palette, Sun, Moon, Monitor, Database, Camera, Shield, CreditCard } from "lucide-react"
import { useTheme } from "next-themes"
import { Button } from "@/components/ui/button"
import { AutoResizeTextarea } from "@/components/ui/auto-resize-textarea"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { PrivacyPolicyContent } from "@/components/privacy/privacy-policy-content"
import {
  clearAllPersistedCaches,
  formatBytes,
  getPersistedCacheSizeBytes,
} from "@/lib/query-persister"
import { tid } from "@/lib/community/testids"
import { Avatar } from "../avatar"
import { Field } from "./field"
import { StatusEditor, hasStatus } from "../social/status-editor"
import {
  SETTINGS_LOGOUT_CLASS,
} from "./settings-navigation"
import { SettingsShell, SettingsShellPanel, type SettingsShellTab } from "./settings-shell"
import { BillingContent } from "../billing/billing-sheet"
import { useBilling, type BillingReturn } from "@/hooks/community/use-billing"
import { AccountDeletionFlow } from "./account-deletion-flow"

const THEME_OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const

type UserSettingsTab = "profile" | "appearance" | "advanced" | "privacy" | "billing"

const USER_SETTINGS_TABS: SettingsShellTab<UserSettingsTab>[] = [
  { value: "profile", label: "My Profile", icon: User },
  { value: "billing", label: "Subscription & billing", icon: CreditCard },
  { value: "appearance", label: "Appearance", icon: Palette },
  { value: "advanced", label: "Advanced", icon: Database },
  { value: "privacy", label: "Privacy", icon: Shield },
]

function AppearanceSettings() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useAtom(useCreateAtom(false))
  useEffect(() => setMounted(true), [setMounted])
  const active = mounted ? theme ?? "system" : undefined

  return (
    <div className="mx-auto w-full max-w-md space-y-4">
      <Field label="Theme">
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-muted/60 p-1">
          {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
            const selected = active === value
            return (
              <button
                key={value}
                onClick={() => setTheme(value)}
                aria-pressed={selected}
                className={[
                  "flex min-h-16 flex-col items-center justify-center gap-2 rounded-lg px-2 text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
                  selected
                    ? "bg-background text-foreground shadow-(--e1)"
                    : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
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

const CACHE_SIZE_QUERY_KEY = ["device", "cache", "size"] as const

export function AdvancedSettings() {
  const [confirmOpen, setConfirmOpen] = useAtom(useCreateAtom(false))
  const [clearError, setClearError] = useAtom(useCreateAtom<string | null>(null))
  const queryClient = useQueryClient()
  const size = useQuery({ queryKey: CACHE_SIZE_QUERY_KEY, queryFn: ({ signal }) => getPersistedCacheSizeBytes(signal), retry: false, staleTime: 0 })
  const clear = useMutation({ meta: { observabilityAction: "cache.clear" }, mutationFn: clearAllPersistedCaches })
  const clearing = clear.isPending
  useObservedQueryRegion("settings", size, 1)
  const cacheSize = size.isPending ? "loading" : size.isError ? "unavailable" : size.data
  const view = useCreateStore({ active: true, generation: 0 })
  const webVersion = process.env.NEXT_PUBLIC_APP_VERSION

  useLayoutEffect(() => {
    view.setState((state) => ({ ...state, active: true }))
    return () => view.setState((state) => ({ active: false, generation: state.generation + 1 }))
  }, [view])

  return (
    <>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(o) => { if (!o) setConfirmOpen(false) }}
        title="Clear local cache?"
        description="This removes locally persisted messages for every account used on this device. The next channel or DM you open will refetch from the server. Nothing on the server is deleted."
        confirmLabel="Clear cache"
        loadingLabel="Clearing..."
        loading={clearing}
        onConfirm={async () => {
          setClearError(null)
          const generation = view.get().generation
          const query = queryClient.getQueryCache().find({ queryKey: CACHE_SIZE_QUERY_KEY, exact: true })
          const assertActive = () => {
            const state = view.get()
            if (!state.active || state.generation !== generation) throw new DOMException("Retired cache settings view", "AbortError")
          }
          try {
            await queryClient.cancelQueries({ queryKey: CACHE_SIZE_QUERY_KEY, exact: true })
            assertActive()
            await clear.mutateAsync()
            assertActive()
            if (query && queryClient.getQueryCache().find({ queryKey: CACHE_SIZE_QUERY_KEY, exact: true }) === query) await queryClient.refetchQueries({ queryKey: CACHE_SIZE_QUERY_KEY, exact: true })
            assertActive()
            setConfirmOpen(false)
          } catch (error) {
            try { assertActive() } catch { return }
            setClearError(error instanceof Error ? error.message : "Device cache has not been fully cleared. Please try again.")
            toastApiError(error, "Failed to clear cache", assertActive)
            setConfirmOpen(false)
          }
        }}
      />
      <div className="mx-auto flex min-h-full w-full max-w-md flex-col">
        <section className="space-y-2">
          <h2 className="text-base font-medium tracking-tight">Clear local cache</h2>
          {clearError && <p role="alert" className="text-sm text-destructive">{clearError}</p>}
          <p className="flex items-baseline justify-between gap-4 text-sm">
            <span className="text-muted-foreground">Cached messages</span>
            <span
              data-testid={tid.settingsCacheSize}
              className="font-mono tabular-nums text-foreground"
            >
              {cacheSize === "loading"
                ? "Calculating…"
                : cacheSize === "unavailable"
                  ? "Unavailable"
                  : formatBytes(cacheSize)}
            </span>
          </p>
          <p className="max-w-[65ch] text-sm leading-6 text-muted-foreground">
            Removes locally persisted messages for every account used on this
            device. The next channel or DM you open will refetch from the server.
            Nothing on the server is deleted.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-2 h-11 sm:h-8"
            onClick={() => setConfirmOpen(true)}
          >
            Clear local cache
          </Button>
        </section>
        {webVersion ? (
          <footer
            data-testid={tid.settingsWebVersion}
            className="mt-auto pt-8 font-mono text-xs tabular-nums text-muted-foreground"
          >
            Web v{webVersion}
          </footer>
        ) : null}
      </div>
    </>
  )
}

export function UserSettings({ initialTab = "profile", billingReturn = null, onClose, userId, userName, userEmail, aboutMe, avatar, statusEmoji, statusText, onSave, onLogout, onAccountDeleted, onUploadAvatar }: {
  initialTab?: UserSettingsTab
  billingReturn?: BillingReturn
  onClose: () => void
  userId: string | null
  userName: string
  userEmail: string
  aboutMe: string
  avatar: string
  statusEmoji?: string | null
  statusText?: string | null
  onSave: (data: { name?: string; aboutMe?: string; statusEmoji?: string | null; statusText?: string | null }) => void
  onLogout?: () => void
  onAccountDeleted: () => Promise<void>
  onUploadAvatar?: () => void
}) {
  // Draft + saved baseline are mount-only on purpose — a WS-driven prop change
  // (e.g. status fan-out echo) must not clobber an in-progress edit. The
  // baseline advances only on a successful save.
  const [name, setName] = useAtom(useCreateAtom(userName))
  const [value, setValue] = useAtom(useCreateAtom(aboutMe))
  const [status, setStatus] = useAtom(useCreateAtom({ emoji: statusEmoji ?? null, text: statusText ?? null }))
  const [baseline, setBaseline] = useAtom(useCreateAtom({
    name: userName,
    aboutMe,
    emoji: statusEmoji ?? null,
    text: statusText ?? null,
  }))
  const [tab, setTab] = useAtom(useCreateAtom<UserSettingsTab>(initialTab))
  useEffect(() => { setTab(initialTab) }, [initialTab, setTab])
  const billing = useBilling(billingReturn, tab === "billing")
  const [deletionOpen, setDeletionOpen] = useAtom(useCreateAtom(false))
  useObservedRegion("settings", tab !== "billing" && tab !== "advanced", { source: "unknown", version: "settings_" + tab, freshness: "unknown", count: 1 })

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
      title={tab === "billing" ? "Subscription & billing" : deletionOpen ? "Delete account" : tab === "appearance" ? "Appearance" : tab === "advanced" ? "Advanced" : tab === "privacy" ? "Privacy Policy" : "My Profile"}
      tabs={USER_SETTINGS_TABS}
      onClose={onClose}
      disabled={deletionOpen}
      navFooter={
        <Button variant="ghost" className={SETTINGS_LOGOUT_CLASS} size="sm" onClick={onLogout} aria-label="Log out" disabled={deletionOpen}>
          <LogOut className="size-4" /> <span className="sr-only sm:not-sr-only">Log Out</span>
        </Button>
      }
    >
      {deletionOpen ? (
        <AccountDeletionFlow
          email={userEmail}
          onCancel={() => setDeletionOpen(false)}
          onDeleted={onAccountDeleted}
        />
      ) : (
        <>
          <SettingsShellPanel value="billing"><div className="mx-auto w-full max-w-xl"><BillingContent billing={billing} /></div></SettingsShellPanel>
          <SettingsShellPanel value="profile">
            <div className="mx-auto w-full max-w-md space-y-8">
              {/* Avatar — centered in a soft rounded frame, with a hand-rolled
                  pill button beneath (matches the bot create/edit sheet; a stock
                  secondary Button reads as the old square style). */}
              <div className="flex flex-col items-center gap-2">
                <span className="block size-24 overflow-hidden rounded-full ring-1 ring-border/50">
                  <Avatar label={avatar} seed={userId ?? undefined} size={96} />
                </span>
                <button
                  type="button"
                  onClick={onUploadAvatar}
                  className="flex min-h-11 items-center gap-2 rounded-full border border-border/50 px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-8"
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
                className="min-h-11 w-full rounded-sm border-0 bg-transparent px-0 py-1 text-xl font-medium leading-[1.2] tracking-tight shadow-none outline-none placeholder:font-normal placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-background sm:text-2xl"
              />
              {/* About — borderless auto-resizing textarea. */}
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">About</div>
                <AutoResizeTextarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  placeholder="Add a bit about yourself…"
                  className="min-h-11 w-full rounded-sm border-0 bg-transparent px-0 py-1 text-sm leading-6 text-foreground shadow-none outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-4 focus-visible:ring-offset-background"
                />
              </div>
              {/* Status — quiet label + a soft chip (more formed than a bare
                  borderless button, still in the frameless language). */}
              <div className="space-y-2">
                <div className="text-xs text-muted-foreground">Status</div>
                <StatusEditor emoji={status.emoji} text={status.text} onChange={(emoji, text) => setStatus({ emoji, text })}>
                  <button className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border/50 px-3 text-sm transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none sm:min-h-8">
                    {hasStatus(status.emoji, status.text) ? (
                      <span>{status.emoji} {status.text}</span>
                    ) : (
                      <span className="text-muted-foreground">Set a status</span>
                    )}
                  </button>
                </StatusEditor>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-11 shrink-0 px-3 text-destructive hover:text-destructive sm:h-8"
                  onClick={() => setDeletionOpen(true)}
                  aria-label="Delete account"
                  data-testid={tid.accountDeletionOpen}
                >
                  Delete account
                </Button>
                <div className="ml-auto flex shrink-0 items-center gap-2">
                  <Button variant="ghost" size="sm" className="h-11 sm:h-8" onClick={handleCancel} disabled={!dirty}>Cancel</Button>
                  <Button size="sm" className="h-11 sm:h-8" onClick={handleSave} disabled={!dirty}>Save changes</Button>
                </div>
              </div>
            </div>
          </SettingsShellPanel>
          <SettingsShellPanel value="appearance">
            <AppearanceSettings />
          </SettingsShellPanel>
          <SettingsShellPanel value="advanced" className="h-full">
            <AdvancedSettings />
          </SettingsShellPanel>
          <SettingsShellPanel value="privacy">
            <div className="mx-auto w-full max-w-2xl pb-8">
              <PrivacyPolicyContent />
            </div>
          </SettingsShellPanel>
        </>
      )}
    </SettingsShell>
  )
}
