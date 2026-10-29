"use client"

import type { CSSProperties } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { AUTOMATION_READ_PERMISSIONS, AutomationAccessCodeCreateSchema, type AutomationAccessCode, type AutomationAccessCodeCreate, type AutomationAccessCodeCreateResponse, type AutomationExpiry, type AutomationPermissionPolicy } from "@alook/shared"
import { ChevronDown, Copy, Pencil, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { useAutomation } from "@/hooks/community/use-automation"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { getErrorMessage } from "@/lib/api/client"
import { isAbortError } from "@/lib/errors"
import { tid } from "@/lib/community/testids"
import { tagColorClassName } from "@/lib/community/tag-color"
import { AutomationSetupPrompt } from "./automation-setup-prompt"

const expiryOptions = [
  ["1h", "1 hour"], ["24h", "24 hours"], ["7d", "7 days"], ["30d", "30 days"], ["forever", "Never expires"],
] as const
const permissionOptions = [
  { permission: "bot.create", label: "Create bots", group: "Write" },
  { permission: "server.create", label: "Create servers", group: "Write" },
  { permission: "server.invite", label: "Invite friends to servers", group: "Write" },
  { permission: "message.send", label: "Send messages", group: "Write" },
  { permission: "machine.read", label: "List machines", group: "Read" },
  { permission: "friend.read", label: "List friends", group: "Read" },
  { permission: "server.read", label: "List servers", group: "Read" },
] as const
const permissionColors: Record<"Read" | "Write", CSSProperties & { "--forum-tag-hue": number }> = {
  Read: { "--forum-tag-hue": 145 },
  Write: { "--forum-tag-hue": 30 },
}
const control = "h-11 sm:h-8"
const selectControl = "data-[size=default]:h-11 sm:data-[size=default]:h-8"

function expiryLabel(code: AutomationAccessCode) {
  if (!code.expiresAt) return "Never expires"
  const time = new Date(code.expiresAt)
  return `${time.getTime() <= Date.now() ? "Expired" : "Expires"} ${time.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}`
}

type DraftPolicy = { enabled: boolean; limit: string; period: AutomationPermissionPolicy["period"] }

export function AutomationCodeForm({ code, pending, onCancel, onSave }: {
  code?: AutomationAccessCode
  pending: boolean
  onCancel: () => void
  onSave: (data: AutomationAccessCodeCreate, renew: boolean) => Promise<void>
}) {
  const [advanced, setAdvanced] = useAtom(useCreateAtom(false))
  const [name, setName] = useAtom(useCreateAtom(code?.name ?? ""))
  const [expiry, setExpiry] = useAtom(useCreateAtom<AutomationExpiry | "keep">(code ? "keep" : "24h"))
  const [policies, setPolicies] = useAtom(useCreateAtom<DraftPolicy[]>(permissionOptions.map(({ permission }) => {
    const existing = code?.permissions.find((policy) => policy.permission === permission)
    return { enabled: code ? Boolean(existing) : (AUTOMATION_READ_PERMISSIONS as readonly string[]).includes(permission), limit: String(existing?.limit ?? 64), period: existing?.period ?? "hour" }
  })))
  const [error, setError] = useAtom(useCreateAtom<string | null>(null))
  const updatePolicy = (index: number, patch: Partial<DraftPolicy>) => setPolicies((current) => current.map((policy, i) => i === index ? { ...policy, ...patch } : policy))
  return (
    <form className="space-y-8" onSubmit={async (event) => {
      event.preventDefault()
      if (pending) return
      setError(null)
      const parsed = AutomationAccessCodeCreateSchema.safeParse({
        name, expiresIn: expiry === "keep" ? "24h" : expiry,
        permissions: policies.flatMap((policy, index) => policy.enabled ? [{ permission: permissionOptions[index].permission, limit: Number(policy.limit), period: policy.period }] : []),
      })
      if (!parsed.success) { if (parsed.error.issues.some((issue) => issue.path.includes("limit"))) setAdvanced(true); setError("Enter a name, select at least one permission, and use a whole-number limit from 1–64 per hour or 1–1,536 per day."); return }
      try { await onSave(parsed.data, expiry !== "keep") } catch (cause) {
        if (!isAbortError(cause)) setError(getErrorMessage(cause, "Could not save this access code. Try again."))
      }
    }}>
      <h2 className="text-base font-medium">{code ? "Edit access code" : "Create access code"}</h2>
      <div className="space-y-4">
        <div className="space-y-2">
          <label htmlFor="automation-name" className="text-sm font-medium">Name</label>
          <Input id="automation-name" data-testid={tid.automationName} className={control} value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required autoComplete="off" placeholder="e.g. Project setup" disabled={pending} />
        </div>
        <div className="space-y-2">
          <label id="automation-expiry-label" className="text-sm font-medium">{code ? "Expiration" : "Expires in"}</label>
          <Select value={expiry} onValueChange={(value) => { if (value) setExpiry(value) }} disabled={pending}>
            <SelectTrigger aria-labelledby="automation-expiry-label" data-testid={tid.automationExpiry} className={`${selectControl} w-full`}><SelectValue>{expiry === "keep" ? "Keep current expiration" : expiryOptions.find(([value]) => value === expiry)?.[1]}</SelectValue></SelectTrigger>
            <SelectContent>{code ? <SelectItem value="keep" className="min-h-11 sm:min-h-8">Keep current expiration</SelectItem> : null}{expiryOptions.map(([value, label]) => <SelectItem key={value} value={value} className="min-h-11 sm:min-h-8">{label}</SelectItem>)}</SelectContent>
          </Select>
          {code ? <p className="text-xs leading-5 text-muted-foreground">{expiry === "keep" ? expiryLabel(code) : "The new expiration starts when you save."}</p> : null}
        </div>
      </div>
      <fieldset className="space-y-4" disabled={pending}>
        <legend className="mb-2 text-sm font-medium">Permissions</legend>
        <p className="text-sm text-muted-foreground">Choose what this code can do. Each permission has its own request limit.</p>
        {(["Read", "Write"] as const).map((group) => <fieldset key={group} className="space-y-2">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">{group}</legend>
          {permissionOptions.map(({ permission, label, group: permissionGroup }, index) => {
          if (permissionGroup !== group) return null
          const policy = policies[index]
          return <div key={permission} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm sm:min-h-8">
              <input type="checkbox" checked={policy.enabled} onChange={(event) => updatePolicy(index, { enabled: event.target.checked })} className="size-4 accent-primary focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring" />
              {label}
            </label>
          </div>
        })}
        </fieldset>)}
      </fieldset>
      <section className="space-y-4">
        <Button type="button" variant="ghost" className={`${control} -ml-2 justify-start gap-2 px-2`} aria-expanded={advanced} aria-controls="automation-rate-limits" onClick={() => setAdvanced(!advanced)} disabled={pending}>
          <ChevronDown className={`size-4 transition-transform ${advanced ? "rotate-180" : ""}`} />Advanced
        </Button>
        {advanced ? <fieldset id="automation-rate-limits" className="space-y-4" disabled={pending}>
          <legend className="mb-2 text-sm font-medium">Request limits</legend>
          <p className="text-xs leading-5 text-muted-foreground">Each permission defaults to 64 requests per hour. Limits use the last hour or 24 hours. Daily limits also have a cap of 64 requests in the last hour.</p>
          {permissionOptions.map(({ permission, label }, index) => {
            const policy = policies[index]
            if (!policy.enabled) return null
            return <div key={permission} className="flex items-center gap-4">
              <span className="min-w-0 flex-1 text-sm">{label}</span>
              <div className="flex shrink-0 items-center gap-2">
                <Input type="number" aria-label={`${label} request limit`} className={`${control} w-24 font-mono tabular-nums`} min={1} max={policy.period === "hour" ? 64 : 1536} step={1} required value={policy.limit} onChange={(event) => updatePolicy(index, { limit: event.target.value })} />
                <Select value={policy.period} onValueChange={(value) => { if (value) updatePolicy(index, { period: value }) }} disabled={pending}>
                  <SelectTrigger className={selectControl} aria-label={`${label} limit period`}><SelectValue>{policy.period === "hour" ? "per hour" : "per day"}</SelectValue></SelectTrigger>
                  <SelectContent><SelectItem value="hour" className="min-h-11 sm:min-h-8">per hour</SelectItem><SelectItem value="day" className="min-h-11 sm:min-h-8">per day</SelectItem></SelectContent>
                </Select>
              </div>
            </div>
          })}
        </fieldset> : null}
      </section>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" className={control} onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" className={control} data-testid={tid.automationSave} disabled={pending}>{pending ? "Saving…" : code ? "Save changes" : "Create access code"}</Button>
      </div>
    </form>
  )
}

function CreatedCode({ result, onDone }: { result: AutomationAccessCodeCreateResponse; onDone: () => void }) {
  const [copyState, setCopyState] = useAtom(useCreateAtom<"idle" | "copied" | "error">("idle"))
  const [confirmDone, setConfirmDone] = useAtom(useCreateAtom(false))
  const source = useCommunityViewSource("automation-secret")
  return <section className="space-y-8">
    <div className="space-y-2">
      <h2 className="text-base font-medium">Access code created</h2>
      <p className="text-sm leading-6 text-muted-foreground">Copy this code now. You cannot view it again after leaving this screen.</p>
    </div>
    <div className="space-y-2">
      <label htmlFor="automation-secret" className="block wrap-break-word text-sm font-medium">{result.accessCode.name}</label>
      <Input id="automation-secret" data-testid={tid.automationSecret} className={`${control} font-mono`} readOnly value={result.secret} autoComplete="off" spellCheck={false} onFocus={(event) => event.target.select()} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" className={control} onClick={async () => {
          const assert = source.capture()
          try { assert(); await navigator.clipboard.writeText(result.secret); assert(); setCopyState("copied") } catch (cause) {
            if (!isAbortError(cause)) { try { assert(); setCopyState("error") } catch { return } }
          }
        }}><Copy className="size-4" />{copyState === "copied" ? "Copied" : "Copy code"}</Button>
        <span role="status" className="text-xs text-muted-foreground">{copyState === "error" ? "Copy failed. Select the code and copy it manually." : copyState === "copied" ? "Code copied" : ""}</span>
      </div>
    </div>
    <div className="flex justify-end"><Button variant="outline" className={control} onClick={() => setConfirmDone(true)}>Done</Button></div>
    <ConfirmDialog open={confirmDone} onOpenChange={setConfirmDone} title="Have you saved your access code?" description="You cannot view this code again after leaving this screen." confirmLabel="I've saved it" confirmVariant="default" onConfirm={onDone} />
  </section>
}

export function AutomationSettings({ userId }: { userId: string }) {
  const { list, execute, pending } = useAutomation(userId)
  const [editing, setEditing] = useAtom(useCreateAtom<AutomationAccessCode | "new" | null>(null))
  const [created, setCreated] = useAtom(useCreateAtom<AutomationAccessCodeCreateResponse | null>(null))
  const [deleting, setDeleting] = useAtom(useCreateAtom<AutomationAccessCode | null>(null))
  const [error, setError] = useAtom(useCreateAtom<string | null>(null))
  return <div className="w-full space-y-8" data-testid={tid.automationPanel}>
    {created ? <CreatedCode result={created} onDone={() => setCreated(null)} /> : editing ? (
      <AutomationCodeForm key={editing === "new" ? "new" : editing.id} code={editing === "new" ? undefined : editing} pending={pending} onCancel={() => setEditing(null)} onSave={async (data, renew) => {
        if (editing === "new") await execute({ kind: "create", data }, setCreated)
        else await execute({ kind: "update", id: editing.id, data: { name: data.name, permissions: data.permissions, ...(renew ? { expiresIn: data.expiresIn } : {}) } })
        setEditing(null)
      }} />
    ) : <>
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="max-w-prose text-sm leading-6 text-muted-foreground">Access codes let scripts read your lists, create bots and servers, invite friends, or send messages. You choose the permissions and limits.</p>
        </div>
        <Button className={control} data-testid={tid.automationCreate} onClick={() => { setError(null); setEditing("new") }}>Create access code</Button>
      </div>
      {list.isPending ? <div aria-label="Loading access codes" role="status" className="space-y-4">{[0, 1].map((i) => <div key={i} className="space-y-2 py-4"><Skeleton className="h-5 w-40" /><Skeleton className="h-4 w-64 max-w-full" /><Skeleton className="h-4 w-48" /></div>)}</div>
        : list.isError ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">Could not load access codes.</p><Button variant="outline" className={control} onClick={() => { void list.refetch() }}>Try again</Button></div>
        : !list.data?.accessCodes.length ? <p className="min-h-32 py-4 text-sm text-muted-foreground">No access codes yet. Create one to allow a script to act on your behalf.</p>
        : <ul className="divide-y divide-border">{list.data.accessCodes.map((code) => <li key={code.id} data-testid={tid.automationCode(code.id)} className="space-y-4 py-4 first:pt-0">
          <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-4 gap-y-2">
            <h2 className="flex min-h-11 min-w-0 items-center text-base leading-6 font-medium sm:min-h-8"><span className="min-w-0 wrap-break-word">{code.name}</span></h2>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Edit ${code.name}`} onClick={() => { setError(null); setEditing(code) }}><Pencil className="size-4" /></Button>
              <Button variant="ghost" size="icon" className="size-11 sm:size-8" aria-label={`Delete ${code.name}`} onClick={() => { setError(null); setDeleting(code) }}><Trash2 className="size-4" /></Button>
            </div>
            <p className="col-span-2 text-xs leading-5 text-muted-foreground">{expiryLabel(code)}</p>
          </div>
          <div className="flex flex-wrap gap-2">{(["Read", "Write"] as const).flatMap((group) => permissionOptions.filter((option) => option.group === group && code.permissions.some((policy) => policy.permission === option.permission)).map(({ permission, label }) => <Badge key={permission} variant="secondary" className={group === "Write" ? "automation-write-color" : tagColorClassName} style={permissionColors[group]} aria-label={`${group}: ${label}`} title={group}>{label}</Badge>))}</div>
        </li>)}</ul>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <AutomationSetupPrompt />
    </>}
    <ConfirmDialog open={Boolean(deleting)} onOpenChange={(open) => { if (!open && !pending) setDeleting(null) }} title={`Delete “${deleting?.name ?? "access code"}”?`} description="Scripts using this code will lose access. This cannot be undone." confirmLabel="Delete code" loadingLabel="Deleting…" loading={pending} onConfirm={async () => {
      if (!deleting || pending) return
      setError(null)
      try { await execute({ kind: "delete", id: deleting.id }); setDeleting(null) } catch (cause) {
        if (!isAbortError(cause)) { setDeleting(null); setError(getErrorMessage(cause, "Could not delete this access code. Try again.")) }
      }
    }} />
  </div>
}
