"use client"

import { useCallback, useEffect } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useMutation } from "@tanstack/react-query"
import { AUTOMATION_READ_PERMISSIONS, AUTOMATION_WRITE_PERMISSIONS, isPresenceOnline, type AutomationAccessCodeCreateResponse } from "@alook/shared"
import { Check, Copy, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { ProviderLogo } from "@/components/provider-logo"
import { useMachines } from "@/hooks/community/use-machines"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { buildPairCommand } from "../machines/pair-machine-sheet"

type Pair = { tokenId: string; expiresAt: string }
type Setup = { signal?: AbortSignal; pair?: Pair; code?: AutomationAccessCodeCreateResponse }
function buildOnboardingAgentPrompt(input: { baseUrl: string; harness: string; command?: string; machineId?: string; secret: string }) {
  return [
    `Read ${input.baseUrl}/agent.md first, then follow ${input.baseUrl}/onboard.md to set up my Alook team.`,
    `Alook server origin: ${input.baseUrl}`,
    `Selected agent: ${input.harness}`,
    input.command ? `Daemon connection command: ${input.command}` : `Connected machine ID: ${input.machineId}`,
    `Onboard access code (valid for one hour): ${input.secret}`,
    "Keep these credentials private. Review what I have recently been working on. Propose how to move that work into an Alook environment with multiple people and bots, and confirm the requirements with me before creating bots or servers. Create no more than 3 bots. Connect the daemon, create the agreed bots and server, invite the bots, and verify every member has joined. Give me the server UI link. Then send the agreed kickoff message on my behalf, identifying yourself as my agent and explaining my goal, so the bots can start work.",
  ].join("\n\n")
}

export function OnboardingAgentDialog({ harness, harnessLabel, onManual, onChooseAgent, onExit }: {
  harness: string; harnessLabel: string; onManual: () => void; onChooseAgent: () => void; onExit: () => void
}) {
  const origin = useCommunityMutationOrigin()
  const source = useCommunityViewSource(`onboarding-agent:${harness}`)
  const { machines, isSuccess, isError, refetch } = useMachines({ refetchInterval: 2000 })
  const machine = machines.find((item) => isPresenceOnline(item.status) && item.availableRuntimes?.some((runtime) => runtime.id === harness && runtime.status !== "unhealthy"))
  const [storedSetup, setSetup] = useAtom(useCreateAtom<Setup>({}))
  const setup = storedSetup.signal === source.signal ? storedSetup : {}
  const [now, setNow] = useAtom(useCreateAtom(0))
  const [copied, setCopied] = useAtom(useCreateAtom<"idle" | "copied" | "error">("idle"))
  const started = useCreateAtom<AbortSignal | null>(null)
  const lock = useCreateAtom<AbortSignal | null>(null)
  const mutation = useMutation({
    mutationKey: ["community", "onboarding-agent", harness], gcTime: 0, retry: false,
    meta: { observabilityAction: "automation.access_code.create" },
    mutationFn: async ({ assert, token }: { assert: ReturnType<typeof source.capture>; token: ReturnType<typeof origin.begin>["token"] }) => {
      assert()
      if (!machine && (!setup.pair || Date.parse(setup.pair.expiresAt) <= Date.now())) {
        const pair = await origin.request<Pair>(token, "/api/community/machines/pair", { method: "POST", signal: assert.signal, assertActive: assert })
        assert()
        setSetup((current) => ({ ...(current.signal === assert.signal ? current : {}), signal: assert.signal, pair }))
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
  const codeExpired = Boolean(setup.code && Date.parse(setup.code.accessCode.expiresAt ?? "") <= now)
  const pairExpired = Boolean(!machine && setup.pair && Date.parse(setup.pair.expiresAt) <= now)
  const ready = Boolean(setup.code && (machine || setup.pair) && !codeExpired && !pairExpired && !pending)
  const prompt = ready && setup.code ? buildOnboardingAgentPrompt({
    baseUrl: location.origin, harness: harnessLabel, secret: setup.code.secret,
    ...(machine ? { machineId: machine.id } : { command: buildPairCommand(setup.pair!.tokenId) }),
  }) : ""
  const exit = () => { source.retire(); setSetup({}); onExit() }
  const leave = (action: () => void) => { source.retire(); setSetup({}); action() }
  const copy = async () => {
    if (!prompt) return
    const assert = source.capture()
    try {
      assert()
      if (Date.parse(setup.code!.accessCode.expiresAt!) <= Date.now() || (!machine && Date.parse(setup.pair!.expiresAt) <= Date.now())) { setNow(Date.now()); return }
      await navigator.clipboard.writeText(prompt)
      assert()
      setCopied("copied")
    } catch { try { assert(); setCopied("error") } catch {} }
  }
  return <Dialog open onOpenChange={(open) => { if (!open) exit() }}>
    <DialogContent data-testid="onboarding-agent-dialog" className="max-h-[calc(100dvh-2rem)] gap-0 overflow-y-auto thin-scrollbar border-0 p-0 shadow-(--e2) ring-0 sm:max-w-xl">
      <DialogHeader className="gap-4 px-4 pt-4 pb-4 sm:px-6 sm:pt-6 sm:pb-6">
        <DialogTitle className="flex items-center gap-2 text-2xl leading-tight font-semibold tracking-tight"><ProviderLogo provider={harness} className="size-5" />Agent Setup</DialogTitle>
        <DialogDescription className="max-w-prose leading-relaxed">Paste this prompt into {harnessLabel}. Your agent will ask about your team, connect your computer, and bring everyone into your server.</DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-4 px-4 pb-4 sm:px-6 sm:pb-6">
        <div className="flex flex-wrap gap-2" aria-label="Setup method">
          <Button type="button" variant="secondary" className="h-11 sm:h-9" aria-pressed>Agent Setup</Button>
          <Button type="button" variant="ghost" className="text-foreground h-11 sm:h-9" aria-pressed={false} onClick={() => leave(onManual)}>Manual</Button>
        </div>
        {ready ? <div className="space-y-2">
          <label htmlFor="onboarding-agent-prompt" className="text-sm font-medium">Prompt for {harnessLabel}</label>
          <textarea id="onboarding-agent-prompt" data-testid="onboarding-agent-prompt" readOnly value={prompt} rows={7} spellCheck={false} autoComplete="off" className="w-full resize-none rounded-md border border-input bg-transparent p-4 text-sm leading-relaxed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring overflow-y-auto thin-scrollbar" />
          <p className="text-sm text-muted-foreground">“onboard” access expires at {new Date(setup.code!.accessCode.expiresAt!).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}. It can create up to 3 bots, create servers, invite members, read setup lists, and send your kickoff message.</p>
          {!machine && setup.pair ? <p className="text-sm text-muted-foreground">Connect before {new Date(setup.pair.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}; the connection key expires sooner.</p> : null}
        </div> : failed || isError || codeExpired || pairExpired ? <div className="space-y-2">
          <p role="alert" className="text-sm text-destructive">{codeExpired || pairExpired ? "Setup credentials expired. Refresh to continue." : "Couldn’t prepare Agent Setup. Try again, or use Manual."}</p>
          <Button type="button" variant="outline" className="h-11 sm:h-9" disabled={pending} onClick={() => { if (isError) void refetch(); else void generate() }}><RefreshCw aria-hidden className="size-4" />{pending ? "Preparing…" : "Try again"}</Button>
        </div> : <div role="status" aria-label="Preparing Agent Setup" className="space-y-4"><Skeleton className="h-48 w-full" /><Skeleton className="h-4 w-3/4" /></div>}
        <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">{machine ? <><Check aria-hidden className="size-4" />{machine.hostname || "Your computer"} is connected. Continue with your agent to build the team.</> : "Waiting for your agent to connect the daemon."}</p>
        {copied !== "idle" ? <p role="status" className="text-sm text-muted-foreground">{copied === "copied" ? "Prompt copied. Paste it into your agent." : "Copy failed. Select the prompt and copy it manually."}</p> : null}
      </div>
      <DialogFooter className="m-0 border-0 bg-transparent px-4 py-4 sm:px-6">
        <Button type="button" variant="ghost" className="text-foreground h-11 sm:h-9" onClick={() => leave(onChooseAgent)}>Change agent</Button>
        <Button type="button" variant="ghost" className="text-foreground h-11 sm:h-9" onClick={exit}>Exit setup</Button>
        <Button type="button" className="h-11 sm:h-9" disabled={!ready} onClick={() => void copy()}><Copy aria-hidden className="size-4" />{copied === "copied" ? "Copied" : "Copy prompt"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
