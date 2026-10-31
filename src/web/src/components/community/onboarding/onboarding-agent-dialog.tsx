"use client"

import { useCallback, useEffect, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useMutation } from "@tanstack/react-query"
import { AUTOMATION_READ_PERMISSIONS, AUTOMATION_WRITE_PERMISSIONS, isPresenceOnline, type AutomationAccessCodeCreateResponse } from "@alook/shared"
import { Copy, RefreshCw, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./onboarding-surface"
import { Skeleton } from "@/components/ui/skeleton"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { buildPairCommand } from "../machines/pair-machine-sheet"

type Pair = { tokenId: string; expiresAt: string; machineId?: string }
type Setup = { signal?: AbortSignal; pair?: Pair; code?: AutomationAccessCodeCreateResponse }
function buildOnboardingAgentPrompt(input: { baseUrl: string; harness: string; command?: string; machineId?: string; secret: string }) {
  return [
    `Follow ${input.baseUrl}/onboard.md to set up my Alook team.`,
    `Selected agent: ${input.harness}`,
    input.command ? `Daemon connection command: ${input.command}` : `Connected machine ID: ${input.machineId}`,
    `Onboard access code (valid for one hour): ${input.secret}`,
  ].join("\n")
}

export function OnboardingAgentDialog({ harness, harnessLabel, onChooseAgent, onExit, onConnected }: {
  harness: string; harnessLabel: string; onChooseAgent: () => void; onExit: () => void; onConnected: () => void
}) {
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(`onboarding-agent:${harness}`)
  const { machines, isSuccess, isError, refetch } = useMachines({ refetchInterval: 2000 })
  const machine = machines.find((item) => isPresenceOnline(item.status) && item.availableRuntimes?.some((runtime) => runtime.id === harness && runtime.status !== "unhealthy"))
  const reconnectMachine = machines.find((item) => !isPresenceOnline(item.status) && item.availableRuntimes?.some((runtime) => runtime.id === harness))
  const [storedSetup, setSetup] = useAtom(useCreateAtom<Setup>({}))
  const setup = storedSetup.signal === source.signal ? storedSetup : {}
  const [now, setNow] = useAtom(useCreateAtom(0))
  const [copied, setCopied] = useAtom(useCreateAtom<"idle" | "copied" | "error">("idle"))
  const [copiedSignal, setCopiedSignal] = useAtom(useCreateAtom<AbortSignal | null>(null))
  const waiting = copied === "copied" && copiedSignal === source.signal
  const waitingStatus = useRef<HTMLDivElement>(null)
  useEffect(() => { if (waiting) waitingStatus.current?.focus() }, [waiting])
  const started = useCreateAtom<AbortSignal | null>(null)
  const lock = useCreateAtom<AbortSignal | null>(null)
  const mutation = useMutation({
    mutationKey: ["community", "onboarding-agent", harness], gcTime: 0, retry: false,
    meta: { observabilityAction: "automation.access_code.create" },
    mutationFn: async ({ assert, token }: { assert: ReturnType<typeof source.capture>; token: ReturnType<typeof origin.begin>["token"] }) => {
      assert()
      if (!machine && (!setup.pair || Date.parse(setup.pair.expiresAt) <= Date.now())) {
        const endpoint = reconnectMachine ? `/api/community/machines/${reconnectMachine.id}/reconnect` : "/api/community/machines/pair"
        const pair = await origin.request<Pair>(token, endpoint, { method: "POST", signal: assert.signal, assertActive: assert })
        assert()
        setSetup((current) => ({ ...(current.signal === assert.signal ? current : {}), signal: assert.signal, pair: { ...pair, machineId: reconnectMachine?.id } }))
      }
      if (!setup.code?.accessCode.expiresAt || Date.parse(setup.code.accessCode.expiresAt) <= Date.now()) {
        const code = await origin.request<AutomationAccessCodeCreateResponse>(token, "/api/community/automation/access-codes", {
          method: "POST", signal: assert.signal, assertActive: assert,
          body: JSON.stringify({ name: "onboard", expiresIn: "1h", permissions: [...AUTOMATION_WRITE_PERMISSIONS, ...AUTOMATION_READ_PERMISSIONS].map((permission) => ({ permission, limit: permission === "bot.create" ? 3 : 64, period: "hour" })) }),
        })
        assert()
        setSetup((current) => ({ ...(current.signal === assert.signal ? current : {}), signal: assert.signal, code }))
      }
      assert()
      setNow(Date.now())
      setCopied("idle")
    },
  })
  const mutate = mutation.mutateAsync
  const generate = useCallback(async () => {
    if (lock.get() === source.signal) return
    const assert = source.capture()
    assert()
    lock.set(assert.signal)
    try { await mutate({ assert, token: origin.begin().token }) }
    catch {}
    finally { if (lock.get() === assert.signal) lock.set(null) }
  }, [lock, source, origin, mutate])
  useEffect(() => {
    if (!isSuccess || started.get() === source.signal) return
    started.set(source.signal)
    void generate()
  }, [isSuccess, started, source.signal, generate])
  useEffect(() => {
    const refresh = () => setNow(Date.now())
    refresh()
    const timer = setInterval(refresh, 1000)
    window.addEventListener("focus", refresh)
    return () => { clearInterval(timer); window.removeEventListener("focus", refresh) }
  }, [setNow])
  const current = mutation.variables?.assert.signal === source.signal
  const pending = current && mutation.isPending
  const failed = current && mutation.isError && !(mutation.error instanceof DOMException && mutation.error.name === "AbortError")
  useEffect(() => {
    if (!waiting || !machine) return
    source.retire()
    setSetup({})
    onConnected()
  }, [waiting, machine, source, setSetup, onConnected])
  const needsConnection = Boolean(isSuccess && setup.code && !machine && !setup.pair && !pending)
  const codeExpired = Boolean(setup.code && Date.parse(setup.code.accessCode.expiresAt ?? "") <= now)
  const pairExpired = Boolean(!machine && setup.pair && Date.parse(setup.pair.expiresAt) <= now)
  const ready = Boolean(setup.code && (machine || setup.pair) && !codeExpired && !pairExpired && !pending)
  const prompt = ready && setup.code ? buildOnboardingAgentPrompt({
    baseUrl: location.origin, harness: harnessLabel, secret: setup.code.secret,
    ...(machine ? { machineId: machine.id } : { command: buildPairCommand(setup.pair!.tokenId, setup.pair!.machineId) }),
  }) : ""
  const exit = () => { source.retire(); setSetup({}); onExit() }
  const leave = (action: () => void) => { source.retire(); setSetup({}); action() }
  const handleCopy = useCallback(async () => {
    if (!prompt) return
    const assert = source.capture()
    try {
      assert()
      if (Date.parse(setup.code!.accessCode.expiresAt!) <= Date.now() || (!machine && Date.parse(setup.pair!.expiresAt) <= Date.now())) { setNow(Date.now()); return }
      await navigator.clipboard.writeText(prompt)
      assert()
      setCopiedSignal(assert.signal)
      setCopied("copied")
    } catch { try { assert(); setCopied("error") } catch {} }
  }, [prompt, source, setup.code, setup.pair, machine, setNow, setCopiedSignal, setCopied])
  return <Dialog open onOpenChange={(open) => { if (!open) exit() }}>
    <DialogContent data-testid="onboarding-agent-dialog" className="border-0 p-6 shadow-none ring-0 sm:max-w-xl">
      <div className="space-y-6 p-4 sm:p-6">
        <div className="flex gap-1.5" role="progressbar" aria-label="Setup progress" aria-valuemin={0} aria-valuemax={2} aria-valuenow={2} aria-valuetext="Step 2 of 2">
          <span className="h-1.5 flex-1 rounded-full bg-(--te)" /><span className="h-1.5 flex-1 rounded-full bg-(--ti)" />
        </div>
        <DialogHeader className="gap-3 text-left">
          <ProviderLogo provider={harness} className="size-8" />
          <DialogTitle className="text-2xl font-semibold tracking-tight">{waiting ? "Waiting for your computer" : `Continue in ${harnessLabel}`}</DialogTitle>
          <DialogDescription>{waiting ? `Paste the copied prompt into ${harnessLabel}. Setup will close when your computer connects.` : `Copy this prompt and paste it into ${harnessLabel}.`}</DialogDescription>
        </DialogHeader>
        {waiting && !codeExpired && !pairExpired ? <div ref={waitingStatus} tabIndex={-1} data-testid="onboarding-agent-waiting" role="status" className="outline-none flex items-center gap-3 text-sm text-muted-foreground"><Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />Waiting for connection…</div> : <div className="space-y-3">
          {ready ? <div className="relative">
            <Input aria-label={`Prompt for ${harnessLabel}`} data-testid="onboarding-agent-prompt" readOnly value={prompt.replace(/\n+/g, " ")} spellCheck={false} autoComplete="off" className="h-11 truncate pr-12 text-sm" />
            <Button type="button" variant="ghost" size="icon" aria-label="Copy prompt" title="Copy prompt" className="absolute top-0 right-0 size-11 rounded-l-none" onClick={handleCopy}><Copy aria-hidden className="size-4" /></Button>
          </div> : failed || isError || codeExpired || pairExpired || needsConnection ? <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">{codeExpired || pairExpired ? "Setup credentials expired. Refresh to continue." : needsConnection ? "Your computer went offline. Prepare a new connection to continue." : "Couldn’t prepare Agent Setup. Try again, or use Manual."}</p>
            <Button type="button" variant="outline" className="h-11" disabled={pending} onClick={() => { if (isError) void refetch(); else void generate() }}><RefreshCw aria-hidden className="size-4" />Try again</Button>
          </div> : <div role="status" aria-label="Preparing Agent Setup"><Skeleton className="h-11 w-full" /></div>}
          {copied === "error" ? <p role="alert" className="text-sm text-destructive">Copy failed. Try again, or select the prompt and copy it.</p> : null}
        </div>}
        <Button type="button" variant="ghost" className="h-11 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" onClick={() => leave(onChooseAgent)}>Change agent</Button>
      </div>
    </DialogContent>
  </Dialog>
}
