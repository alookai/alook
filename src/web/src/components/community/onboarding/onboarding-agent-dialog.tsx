"use client"

import { useCallback, useEffect, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useMutation } from "@tanstack/react-query"
import { AUTOMATION_PERMISSION_LIMITS, AUTOMATION_READ_PERMISSIONS, AUTOMATION_WRITE_PERMISSIONS, isPresenceOnline, type AutomationAccessCodeCreateResponse } from "@alook/shared"
import { CircleHelp, Copy, Loader2, RefreshCw } from "@/components/icons/lucide";
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { PromptCopyPreview } from "@/components/ui/prompt-copy-preview"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, OnboardingProgress } from "./onboarding-surface"
import { Skeleton } from "@/components/ui/skeleton"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { MachinePairMessageDiagram } from "../machines/machine-pair-message-diagram"
import { buildPairCommand } from "../machines/pair-machine-sheet"

type Pair = { tokenId: string; expiresAt: string; machineId?: string }
type Setup = { signal?: AbortSignal; pair?: Pair; code?: AutomationAccessCodeCreateResponse }
function buildOnboardingAgentPrompt(input: { baseUrl: string; command?: string; machineId?: string; secret: string }) {
  return [
    `Follow ${input.baseUrl}/onboard.md to set up my Alook team.`,
    input.command ? `Daemon: ${input.command}` : `Machine: ${input.machineId}`,
    `Access code (1h): ${input.secret}`,
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
          body: JSON.stringify({ name: "onboard", purpose: "onboarding", expiresIn: "1h", permissions: [...AUTOMATION_WRITE_PERMISSIONS, ...AUTOMATION_READ_PERMISSIONS].map((permission) => ({ permission, limit: permission === "bot.create" ? 3 : AUTOMATION_PERMISSION_LIMITS.hour, period: "hour" })) }),
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
    const assert = source.tryCapture()
    if (!assert) return
    assert()
    lock.set(assert.signal)
    try { await mutate({ assert, token: origin.begin().token }) }
    catch {}
    finally { if (lock.get() === assert.signal) lock.set(null) }
  }, [lock, source, origin, mutate])
  useEffect(() => {
    if (!isSuccess || started.get() === source.signal) return
    if (!source.tryCapture()) return
    started.set(source.signal)
    void generate()
  }, [isSuccess, started, source, generate])
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
    baseUrl: location.origin, secret: setup.code.secret,
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
  const handleManualCopy = useCallback(() => {
    if (!prompt || !setup.code) return
    if (Date.parse(setup.code.accessCode.expiresAt ?? "") <= Date.now() || (!machine && Date.parse(setup.pair?.expiresAt ?? "") <= Date.now())) {
      setNow(Date.now())
      return
    }
    setCopiedSignal(source.signal)
    setCopied("copied")
  }, [prompt, setup.code, setup.pair, machine, source.signal, setNow, setCopiedSignal, setCopied])
  return <Dialog open onOpenChange={(open) => { if (!open) exit() }}>
    <DialogContent data-testid="onboarding-agent-dialog" className="border-0 p-6 shadow-none ring-0 sm:max-w-xl">
      <div className="min-w-0 space-y-6 p-4 sm:p-6">
        <OnboardingProgress current={2} total={2} />
        <DialogHeader className="gap-3 text-left">
          <ProviderLogo provider={harness} className="size-8" />
          <DialogTitle className="text-2xl font-semibold tracking-tight">{waiting ? "Waiting for your computer to connect" : `Set up with ${harnessLabel}`}</DialogTitle>
          <DialogDescription>{waiting ? `Paste the copied prompt into ${harnessLabel}. We’ll take you right in once your computer connects.` : `Copy and paste this into ${harnessLabel}. It only lets your local agent send and receive Alook messages, and asks before creating your first room.`}</DialogDescription>
        </DialogHeader>
        <p className="rounded-lg bg-muted/40 px-3.5 py-2.5 text-sm leading-relaxed text-muted-foreground sm:hidden">
          On your phone? Open <span className="font-medium text-foreground">alook.ai</span> on the computer where {harnessLabel} is installed to connect it — you can still explore Alook here.
        </p>
        {waiting && !codeExpired && !pairExpired ? <div ref={waitingStatus} tabIndex={-1} data-testid="onboarding-agent-waiting" role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3.5 py-3 text-sm text-muted-foreground outline-none">
          <span className="flex items-center gap-2.5"><Loader2 aria-hidden className="size-4 shrink-0 animate-spin motion-reduce:animate-none" />Waiting for your computer to connect…</span>
          <Button type="button" variant="ghost" size="sm" className="h-9 text-foreground" onClick={handleCopy}><Copy aria-hidden className="size-3.5" />Copy again</Button>
        </div> : <div className="space-y-3">
          {ready ? <>
            <PromptCopyPreview value={prompt} label={`Prompt for ${harnessLabel}`} testId="onboarding-agent-prompt" onCopy={handleCopy} onManualCopy={handleManualCopy} />
            <div className="flex items-center">
              <Popover>
                <PopoverTrigger
                  openOnHover
                  delay={150}
                  render={<Button variant="ghost" size="sm" type="button" />}
                  className="-mx-2 h-11 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground sm:h-8"
                >
                  <CircleHelp aria-hidden className="size-3.5 shrink-0" />
                  Why do I need to run this command?
                </PopoverTrigger>
                <PopoverContent
                  side="bottom"
                  align="end"
                  className="flex w-104 max-w-[calc(var(--app-safe-width)-2rem)] max-h-[calc(var(--app-overlay-safe-height)-2rem)] flex-col overflow-hidden p-0"
                >
                  <ScrollArea
                    className="flex min-h-0 flex-1 flex-col"
                    viewportClassName="min-h-0 flex-1 overflow-x-hidden overflow-y-auto"
                    contentClassName="flex flex-col gap-4 p-4 sm:p-6"
                  >
                    <div className="flex flex-col gap-2">
                      <PopoverTitle className="text-lg leading-tight tracking-[-0.015em]">Why do I need to run this command?</PopoverTitle>
                      <p className="text-sm leading-relaxed text-muted-foreground">Your AI tool runs on your computer. This only lets your local agent send and receive Alook messages using your existing setup.</p>
                    </div>
                    <MachinePairMessageDiagram />
                    <div className="flex flex-col gap-2">
                      <h4 className="text-base font-semibold leading-tight">Your files stay on your computer</h4>
                      <p className="text-sm leading-relaxed text-muted-foreground">Alook never automatically uploads your local files.</p>
                    </div>
                  </ScrollArea>
                </PopoverContent>
              </Popover>
            </div>
          </> : failed || isError || codeExpired || pairExpired || needsConnection ? <div className="space-y-3">
            <p role="alert" className="text-sm text-destructive">{codeExpired || pairExpired ? "This setup code expired. Refresh to get a new one." : needsConnection ? "Your computer went offline. Refresh to reconnect it." : "Couldn’t prepare the prompt. Try again, or switch to Terminal."}</p>
            <Button type="button" variant="outline" className="h-11" disabled={pending} onClick={() => { if (isError) void refetch(); else void generate() }}><RefreshCw aria-hidden className="size-4" />Try again</Button>
          </div> : <div role="status" aria-label="Preparing setup prompt"><Skeleton className="h-11 w-full" /></div>}
          {copied === "error" ? <p role="alert" className="text-sm text-destructive">Copy failed. Try again, or select the prompt and copy it.</p> : null}
        </div>}
        <Button type="button" variant="outline" className="h-11 px-3" onClick={() => leave(onChooseAgent)}>Choose another tool</Button>
      </div>
    </DialogContent>
  </Dialog>
}
