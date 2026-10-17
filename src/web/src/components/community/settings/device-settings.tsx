"use client"

import { useEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useMutation, useQuery } from "@tanstack/react-query"
import { authClient } from "@/lib/auth-client"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { isAbortError } from "@/lib/errors"
import { isTouchClient } from "@/lib/touch/client"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"

export function DeviceSettings({ userId, userCode = "", active }: { userId: string | null; userCode?: string; active: boolean }) {
  const [input, setInput] = useAtom(useCreateAtom(userCode))
  const [code, setCode] = useAtom(useCreateAtom(userCode.trim()))
  const [revokeTarget, setRevokeTarget] = useAtom(useCreateAtom<{ token: string; label: string } | null>(null))
  useEffect(() => { setInput(userCode); setCode(userCode.trim()) }, [userCode, setInput, setCode])
  const origin = useCommunityMutationOrigin()
  const enabled = active && !!userId && origin.registry?.accountId === userId
  const source = useCommunityViewSource(`devices:${userId}:${code}`, enabled)
  const capture = () => { const assert = source.capture(); assert(); return assert }
  const options = (original: ReturnType<typeof capture>, signal?: AbortSignal) => ({
    signal: signal ? AbortSignal.any([signal, original.signal]) : original.signal,
    onRequest: () => original(), onSuccess: () => original(), onError: () => original(),
  })
  const sessions = useQuery({
    queryKey: ["community", "device-sessions", userId], enabled, subscribed: enabled, retry: false, gcTime: 0,
    queryFn: async ({ signal }) => {
      const original = capture()
      const result = await authClient.listSessions({ fetchOptions: options(original, signal) })
      original()
      if (result.error) throw new Error(result.error.message || "Could not load devices")
      return result.data ?? []
    },
  })
  const verification = useQuery({
    queryKey: ["community", "device-verification", userId, code], enabled: enabled && !!code, subscribed: enabled && !!code, retry: false, gcTime: 0,
    queryFn: async ({ signal }) => {
      const original = capture()
      const result = await authClient.device({ query: { user_code: code }, fetchOptions: options(original, signal) })
      original()
      if (result.error) throw new Error(result.error.error_description || "Invalid or expired code")
      if (!isTouchClient(result.data)) throw new Error("This code is not for Alook Touch. Open its original authorization page.")
      return result.data
    },
  })
  const verified = verification.isSuccess && !verification.isFetching
  const decision = useMutation({
    meta: { observabilityAction: "device.authorization.command" },
    mutationKey: ["community", "device-decision", userId, code],
    scope: { id: JSON.stringify(["device-decision", userId, code]) },
    mutationFn: async ({ kind, requestCode, original }: { kind: "approve" | "deny"; requestCode: string; original: ReturnType<typeof capture> }) => {
      original()
      if (!verified || requestCode !== code || !isTouchClient(verification.data) || verification.data?.status !== "pending") throw new Error("Verify a pending Touch code first")
      const result = kind === "approve" ? await authClient.device.approve({ userCode: requestCode, fetchOptions: options(original) }) : await authClient.device.deny({ userCode: requestCode, fetchOptions: options(original) })
      original()
      if (result.error) throw new Error(result.error.error_description || "Could not authorize device")
      return kind
    },
  })
  const revoke = useMutation({
    meta: { observabilityAction: "device.session.revoke" },
    mutationKey: ["community", "device-revoke", userId], scope: { id: JSON.stringify(["device-revoke", userId]) },
    mutationFn: async ({ token, original }: { token: string; original: ReturnType<typeof capture> }) => {
      original()
      const result = await authClient.revokeSession({ token, fetchOptions: options(original) })
      original()
      if (result.error) throw new Error(result.error.message || "Could not revoke access")
      setRevokeTarget(null)
      await sessions.refetch({ cancelRefetch: false })
      original()
    },
  })
  const resetDecision = decision.reset
  useEffect(() => { resetDecision(); setRevokeTarget(null) }, [code, active, userId, setRevokeTarget, resetDecision])
  const currentDecision = decision.variables?.requestCode === code ? decision : null
  const failure = currentDecision?.error ?? revoke.error ?? verification.error ?? sessions.error
  const error = !isAbortError(failure) && failure instanceof Error ? failure.message : ""
  const decided = currentDecision?.isSuccess ? currentDecision.data : verified && verification.data?.status === "approved" ? "approve" : verified && verification.data?.status === "denied" ? "deny" : null
  const waiting = verified && verification.data?.status === "pending" && !decided
  if (!enabled) return null
  return <div className="mx-auto flex w-full max-w-xl flex-col gap-8" data-testid="device-settings">
    <section className="space-y-4">
      <h2 className="font-medium">Authorize Alook Touch</h2>
      <p className="text-sm text-muted-foreground">Enter the code on your Touch. Approve only when the codes match. Touch gets its own session to read your existing DMs and send messages you confirm.</p>
      <form className="flex items-end gap-4" onSubmit={event => { event.preventDefault(); decision.reset(); const next = input.trim(); if (next === code) void verification.refetch(); else setCode(next) }}>
        <label className="flex min-w-0 flex-1 flex-col gap-2 text-sm">Device code<Input aria-label="Device code" disabled={decision.isPending} value={input} onChange={event => setInput(event.target.value.toUpperCase())} placeholder="XXXX-XXXX" /></label>
        <Button type="submit" variant="outline" disabled={!input.trim() || verification.isFetching || decision.isPending}>Verify code</Button>
      </form>
      {verification.isFetching && <p role="status">Verifying code…</p>}
      {waiting && <div className="space-y-4" data-testid="device-authorization-review">
        <p>Code: <strong className="font-mono">{code}</strong></p>
        <div className="flex gap-4"><Button variant="outline" disabled={decision.isPending} onClick={() => decision.mutate({ kind: "deny", requestCode: code, original: capture() })}>Deny</Button><Button disabled={decision.isPending} onClick={() => decision.mutate({ kind: "approve", requestCode: code, original: capture() })}>Approve Touch</Button></div>
      </div>}
      {decided && <p role="status">{decided === "approve" ? "Touch authorized. It will continue automatically." : "Device access denied."}</p>}
    </section>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4"><h2 className="font-medium">Sessions</h2><Button variant="ghost" disabled={sessions.isFetching || revoke.isPending} onClick={() => void sessions.refetch()}>Refresh</Button></div>
      <p className="text-sm text-muted-foreground">Revoke access for a lost device. Device names come from session browser information. An offline Touch closes private content when it reconnects and checks its session.</p>
      {sessions.isPending && <p>Loading sessions…</p>}
      {sessions.isSuccess && sessions.data.length === 0 && <p>No active sessions.</p>}
      {sessions.data?.map(item => {
        const label = item.userAgent?.startsWith("AlookTouch/") ? item.userAgent.split(" ", 1)[0] : item.userAgent || "Device session"
        return <div key={item.id} className="flex flex-col gap-4 rounded-lg border p-4" data-testid="device-session">
          <p className="wrap-break-word font-medium">{label}</p><p className="text-sm text-muted-foreground">Created {new Date(item.createdAt).toLocaleString()}</p>
          <Button variant="outline" disabled={revoke.isPending} onClick={() => setRevokeTarget({ token: item.token, label })}>Revoke access</Button>
        </div>
      })}
    </section>
    <ConfirmDialog open={!!revokeTarget} onOpenChange={open => { if (!open && !revoke.isPending) setRevokeTarget(null) }} title="Revoke device access?" description={`This ends the session for ${revokeTarget?.label ?? "this device"}. Other sessions stay active.`} confirmLabel="Revoke access" loading={revoke.isPending} onConfirm={() => { if (revokeTarget && !revoke.isPending) revoke.mutate({ token: revokeTarget.token, original: capture() }) }} />
  </div>
}
