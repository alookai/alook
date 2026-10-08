"use client"

import { useCreateAtom } from "@tanstack/react-store";
import { useQuery, useMutation } from "@tanstack/react-query"
import { useCommunityMutationOrigin } from "@/hooks/community/community-origin"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { useCallback, useEffect } from "react"
import { toast } from "sonner"
import { CircleHelp, Copy, Loader2, RefreshCw, TerminalIcon } from "lucide-react"
import { isDesktop, isTauri, tauriInvoke } from "@alook/shared"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/components/ui/popover"
import { toastApiError } from "@/lib/api/client"
import { tid } from "@/lib/community/testids"
import { isLocalServiceEnvironment, WS_DO_PORT_DEFAULT } from "@/lib/utils"
import { websocketUrl } from "@/lib/websocket-url"
import { MachinePairMessageDiagram } from "./machine-pair-message-diagram"

// Production daemons use their built-in endpoints. Local development appends
// the browser origin and local ws-do address so the command stays on the dev stack.
// Only ever called once `pendingTokenId` is set, which happens from a
// client-only effect — safe to touch `location` in the local branch.
export function buildPairCommand(machineKey: string, machineId?: string): string {
  const isLocal = isLocalServiceEnvironment()
  const bin = isLocal
    ? "pnpm daemon"
    : "npx --yes @alook/daemon@latest daemon"
  const action = machineId
    ? `reconnect --id ${machineId} --machine-key ${machineKey}`
    : `start --machine-key ${machineKey}`
  const command = `${bin} ${action}`
  if (!isLocal) return command
  const { serverUrl, wsUrl } = pairEndpoints()
  return `${command} --server-url ${serverUrl} --ws-url ${wsUrl}`
}

function pairEndpoints(): { serverUrl: string; wsUrl: string } {
  const wsUrl = websocketUrl("community-daemon", { local: true, port: WS_DO_PORT_DEFAULT })
  return { serverUrl: location.origin, wsUrl }
}

export type PairMachineSheetMode =
  | { kind: "pair" }
  | { kind: "reconnect"; machineId: string; hostname: string }

type DaemonRuntimeCapability = {
  available: boolean
  reason: string | null
  nodeVersion: string | null
}

function nativeErrorMessage(error: unknown, fallback: string): string {
  if (typeof error === "string" && error.trim()) return error.trim()
  if (error instanceof Error && error.message) return error.message
  return fallback
}

export function PairMachineSheet({
  open,
  onOpenChange,
  pendingTokenId,
  setPendingTokenId,
  connectedHostname,
  mode = { kind: "pair" },
  onLimitReached,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingTokenId: string | null
  setPendingTokenId: (tokenId: string | null) => void
  connectedHostname: string | null
  mode?: PairMachineSheetMode
  onLimitReached?: () => void
}) {
  const isReconnect = mode.kind === "reconnect"
  const origin = useCommunityMutationOrigin()
  const openKey = mode.kind === "reconnect" ? `reconnect:${mode.machineId}` : "pair"
  const source = useCommunityViewSource(`machine-pair:${openKey}`, open)
  const desktopNative = isTauri() && isDesktop()
  const generation = useMutation({ meta: { observabilityAction: "machine.pair.generate" },
    gcTime: 0,
    mutationKey: ["community", "machine-pair", openKey],
    mutationFn: async ({ token, assert }: { token: ReturnType<typeof origin.begin>["token"]; assert: ReturnType<typeof source.capture> }) => {
      assert()
      const endpoint = mode.kind === "reconnect" ? `/api/community/machines/${mode.machineId}/reconnect` : "/api/community/machines/pair"
      const result = await origin.request<{ tokenId: string; expiresAt: string }>(token, endpoint, { method: "POST", signal: assert.signal, assertActive: assert })
      assert()
      return result
    },
  })
  const generating = generation.isPending && generation.variables?.assert.signal === source.signal
  const generationError = generation.variables?.assert.signal === source.signal && generation.isError && !(generation.error instanceof DOMException && generation.error.name === "AbortError") ? "Couldn't generate a key — try again." : null
  const mutateGeneration = generation.mutateAsync
  const generate = useCallback(async () => {
    const assert = source.capture(), token = origin.begin().token
    assert()
    try {
      const result = await mutateGeneration({ token, assert })
      assert()
      setPendingTokenId(result.tokenId)
    } catch (error) {
      try { assert() } catch { return }
      if (error instanceof Error && error.message === "MACHINE_LIMIT_REACHED" && onLimitReached) { onLimitReached(); return }
      toastApiError(error, "Couldn't generate a key — try again.", assert)
    }
  }, [mutateGeneration, source, origin, setPendingTokenId, onLimitReached])
  const generatedForKey = useCreateAtom<{ key: string; signal: AbortSignal } | null>(null)
  useEffect(() => {
    if (!open) { generatedForKey.set(null); return }
    const previous = generatedForKey.get()
    if (previous?.key === openKey && previous.signal === source.signal) return
    generatedForKey.set({ key: openKey, signal: source.signal })
    setPendingTokenId(null)
    void generate()
  }, [open, openKey, setPendingTokenId, source.signal, generatedForKey, generate])
  const capability = useQuery({
    queryKey: ["community", "daemon-runtime-capability"], enabled: open && desktopNative, subscribed: open && desktopNative,
    gcTime: 0, retry: false,
    queryFn: async ({ signal }) => {
      const token = origin.begin().token
      origin.assert(token)
      try {
        const result = await tauriInvoke<DaemonRuntimeCapability>("daemon_runtime_capability")
        origin.assert(token)
        if (signal.aborted) throw new DOMException("Cancelled native runtime check", "AbortError")
        return result
      } catch (error) {
        origin.assert(token)
        if (signal.aborted) throw new DOMException("Cancelled native runtime check", "AbortError")
        throw error
      }
    },
  })
  const runtimeCapability = capability.data ?? (capability.error ? {
    available: false, reason: nativeErrorMessage(capability.error, "Alook couldn't check Node.js and npm on this computer."), nodeVersion: null,
  } : null)
  const checkingRuntime = open && desktopNative && capability.isPending
  const launch = useMutation({ meta: { observabilityAction: "machine.pair.launch" },
    gcTime: 0,
    mutationKey: ["community", "machine-pair", openKey, "launch"],
    mutationFn: async ({ key, machineId, assert }: { key: string; machineId: string | null; assert: ReturnType<typeof source.capture> }) => {
      assert()
      const result = await tauriInvoke<{ success: boolean; message: string }>("daemon_pair", { machineKey: key, machineId })
      assert()
      if (!result.success) throw new Error(result.message || "The daemon did not start")
      return { key }
    },
  })
  const currentLaunch = launch.variables?.assert.signal === source.signal
  const connecting = currentLaunch && launch.isPending
  const started = currentLaunch && launch.isSuccess && launch.data.key === pendingTokenId
  const launchError = currentLaunch && launch.error && !(launch.error instanceof DOMException && launch.error.name === "AbortError")
    ? nativeErrorMessage(launch.error, "Couldn't start the daemon. Run the command below in a terminal instead.") : null
  const command = pendingTokenId ? buildPairCommand(pendingTokenId, mode.kind === "reconnect" ? mode.machineId : undefined) : ""
  const copyCommand = async () => {
    if (!command) return
    const assert = source.capture()
    assert()
    try { await navigator.clipboard.writeText(command); assert(); toast.success("Command copied") }
    catch (error) { try { assert() } catch { return }; if (!(error instanceof DOMException && error.name === "AbortError")) toast.error("Copy failed") }
  }
  const connectDesktop = async () => {
    if (!pendingTokenId || connecting || !runtimeCapability?.available) return
    const assert = source.capture()
    assert()
    try {
      await launch.mutateAsync({ key: pendingTokenId, machineId: mode.kind === "reconnect" ? mode.machineId : null, assert })
      assert()
      toast.success(isReconnect ? "Machine reconnected" : "This computer is connecting")
    } catch (error) {
      try { assert() } catch { return }
      if (!(error instanceof DOMException && error.name === "AbortError")) toast.error(nativeErrorMessage(error, "Couldn't start the daemon. Run the command below in a terminal instead."))
    }
  }


  return (
    <CommunitySheet
      open={open}
      onOpenChange={onOpenChange}
      title={isReconnect ? `Reconnect ${mode.hostname || "machine"}` : "Connect a machine"}
      description={isReconnect
        ? "Run this command before it expires. It safely replaces the running daemon, then rotates its key."
        : "Run this on the computer you want to connect. The key is good for 15 minutes."}
      bodyClassName="flex flex-col gap-6"
      footer={(requestClose) => (
        <Button variant="secondary" className="min-h-11!" onClick={requestClose}>
          Done
        </Button>
      )}
    >
          <PairMachineSteps
            command={command}
            generating={generating || !command}
            generationError={generationError}
            onRetry={() => void generate()}
            onCopy={copyCommand}
            desktopNative={desktopNative}
            checkingRuntime={checkingRuntime}
            runtimeCapability={runtimeCapability}
            launchError={launchError}
            connecting={connecting}
            started={started}
            onConnectDesktop={connectDesktop}
            connectedHostname={connectedHostname}
          />
    </CommunitySheet>
  )
}

export function PairMachineSteps({
  command,
  generating,
  generationError = null,
  onRetry,
  onCopy,
  connectedHostname,
  step1MotionTarget,
  step2MotionTarget,
  step1ClassName,
  step2ClassName,
  headingAs = "h3",
  desktopNative = false,
  checkingRuntime = false,
  runtimeCapability = null,
  launchError = null,
  connecting = false,
  started = false,
  onConnectDesktop,
  concise = false,
}: {
  command: string
  generating: boolean
  generationError?: string | null
  onRetry?: () => void
  onCopy: () => void
  connectedHostname: string | null
  step1MotionTarget?: string
  step2MotionTarget?: string
  step1ClassName?: string
  step2ClassName?: string
  headingAs?: "h3" | "div"
  desktopNative?: boolean
  checkingRuntime?: boolean
  runtimeCapability?: DaemonRuntimeCapability | null
  launchError?: string | null
  connecting?: boolean
  started?: boolean
  onConnectDesktop?: () => void
  concise?: boolean
}) {
  return (
    <>
      <div data-motion-target={step1MotionTarget} className={step1ClassName}>
        <Step1
          command={command}
          generating={generating}
          generationError={generationError}
          onRetry={onRetry}
          onCopy={onCopy}
          headingAs={headingAs}
          desktopNative={desktopNative}
          checkingRuntime={checkingRuntime}
          runtimeCapability={runtimeCapability}
          launchError={launchError}
          connecting={connecting}
          started={started}
          onConnectDesktop={onConnectDesktop}
          concise={concise}
        />
      </div>
      <div data-motion-target={step2MotionTarget} className={step2ClassName}>
        <Step2
          ready={desktopNative && runtimeCapability?.available ? started : Boolean(command)}
          connectedHostname={connectedHostname}
          headingAs={headingAs}
        />
      </div>
    </>
  )
}

function Step1({
  command,
  generating,
  generationError,
  onRetry,
  onCopy,
  headingAs: Heading,
  desktopNative,
  checkingRuntime,
  runtimeCapability,
  launchError,
  connecting,
  started,
  onConnectDesktop,
  concise,
}: {
  command: string
  generating: boolean
  generationError: string | null
  onRetry?: () => void
  onCopy: () => void
  headingAs: "h3" | "div"
  desktopNative: boolean
  checkingRuntime: boolean
  runtimeCapability: DaemonRuntimeCapability | null
  launchError: string | null
  connecting: boolean
  started: boolean
  onConnectDesktop?: () => void
  concise: boolean
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Marker n={1} done={!generating} />
        <Heading className="font-heading text-sm font-medium leading-tight tracking-[-0.015em] text-foreground">
          {concise ? "Run one command" : "Run this on your machine"}
        </Heading>
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={150}
            data-testid={tid.machinePairHelp}
            aria-label="Why run a terminal command?"
            render={<button type="button" />}
            className="grid size-11 shrink-0 place-items-center rounded-md text-foreground hover:bg-accent active:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:size-8"
          >
            <CircleHelp aria-hidden className="size-5" />
          </PopoverTrigger>
          <PopoverContent
            data-testid={tid.machinePairHelpContent}
            side="bottom"
            align="end"
            className="flex w-104 max-w-[calc(100vw-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-y-auto thin-scrollbar p-4 sm:p-6"
          >
            <div className="flex flex-col gap-2">
              <PopoverTitle className="text-lg leading-tight tracking-[-0.015em]">Why run a terminal command?</PopoverTitle>
              <p className="text-sm leading-relaxed text-muted-foreground">Your CLI agents run on your computer. This command starts a background service so they can receive messages and reply in Alook, using your existing setup.</p>
            </div>
            <MachinePairMessageDiagram />
            <div className="flex flex-col gap-2">
              <h4 className="text-base font-semibold leading-tight">No automatic file uploads</h4>
              <p className="text-sm leading-relaxed text-muted-foreground">Alook does not automatically upload any of your local file contents.</p>
            </div>
          </PopoverContent>
        </Popover>
      </header>
      <p className="text-sm text-muted-foreground">
        {concise
          ? (
              <>
                Paste it into{" "}
                <span className="inline-flex items-center gap-1 align-middle text-foreground">
                  <TerminalIcon aria-hidden className="size-3.5" />
                  Terminal.
                </span>{" "}
                Node.js and npm are required.
              </>
            )
          : "Open a terminal on the computer you want to connect, paste the command, and hit enter. Node.js with npm is required."}
      </p>
      {generationError ? (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-destructive/25 bg-destructive/5 p-3">
          <p role="alert" className="text-sm text-destructive">
            {generationError}
          </p>
          {onRetry ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid={tid.machinePairRetry}
              onClick={onRetry}
            >
              <RefreshCw className="size-4" />
              Try again
            </Button>
          ) : null}
        </div>
      ) : generating ? (
        <div className="flex items-center gap-2 rounded-lg border bg-muted/30 p-3 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Preparing your command…
        </div>
      ) : (
        <>
          {desktopNative && (
            <div className="flex flex-col gap-2">
              {runtimeCapability?.available && (
                <Button
                  data-testid={tid.machinePairDesktopConnect}
                  onClick={onConnectDesktop}
                  disabled={connecting || started}
                  className="w-full"
                >
                  {connecting && <Loader2 className="size-4 animate-spin" />}
                  {connecting ? "Connecting…" : started ? "Daemon started" : "Connect this computer"}
                </Button>
              )}
              {(checkingRuntime || !runtimeCapability?.available || launchError) && (
                <p
                  data-testid={tid.machinePairRuntimeHint}
                  role={launchError || runtimeCapability?.reason ? "status" : undefined}
                  className="text-sm text-muted-foreground"
                >
                  {launchError
                    ? `${launchError} The terminal command remains available below.`
                    : checkingRuntime
                      ? "Checking this computer for Node.js and npm…"
                      : runtimeCapability?.reason ?? "Node.js and npm are required for one-click connection."}
                </p>
              )}
            </div>
          )}
          <div className="flex items-start gap-2 rounded-lg border bg-muted/30 p-3 font-mono text-xs">
            <code data-testid={tid.machinePairCommand} className="flex-1 break-all">
              {command}
            </code>
            <button
              data-testid={tid.machinePairCopy}
              onClick={onCopy}
              className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
              aria-label="Copy command"
            >
              <Copy className="size-3.5" />
            </button>
          </div>
        </>
      )}
    </section>
  )
}

function Step2({
  ready,
  connectedHostname,
  headingAs: Heading,
}: {
  ready: boolean
  connectedHostname: string | null
  headingAs: "h3" | "div"
}) {
  if (connectedHostname) {
    return (
      <section data-testid={tid.machinePairStatus} className="flex flex-col gap-3">
        <header className="flex items-center gap-2">
          <Marker n={2} done />
          <Heading className="font-heading text-sm font-medium leading-tight tracking-[-0.015em] text-foreground">
            Connected
          </Heading>
        </header>
        <div className="flex flex-col gap-1 text-sm">
          <span className="flex items-center gap-2">
            <span className="text-[15px] font-medium text-foreground">{connectedHostname}</span>
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-1 text-[11px] font-medium text-emerald-600 dark:text-emerald-400">
              <span className="inline-block size-1.5 rounded-full bg-status-online" />Online
            </span>
          </span>
          <span className="text-muted-foreground">is ready for your bot friends.</span>
        </div>
      </section>
    )
  }
  return (
    <section data-testid={tid.machinePairStatus} className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Marker n={2} muted={!ready} spinning={ready} />
        <Heading
          className={[
            "font-heading text-sm font-medium leading-tight tracking-[-0.015em]",
            ready ? "text-foreground" : "text-muted-foreground",
          ].join(" ")}
        >
          Waiting for the daemon…
        </Heading>
      </header>
    </section>
  )
}

function Marker({
  n,
  muted,
  done,
  spinning,
}: {
  n: number
  muted?: boolean
  done?: boolean
  spinning?: boolean
}) {
  return (
    <span
      className={[
        "relative grid size-6 place-items-center rounded-full text-xs font-medium",
        done
          ? "bg-emerald-500 text-white"
          : muted
            ? "bg-muted text-muted-foreground"
            : "bg-primary text-primary-foreground",
      ].join(" ")}
    >
      {spinning && (
        <span className="absolute -inset-0.75 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
      )}
      {n}
    </span>
  )
}
