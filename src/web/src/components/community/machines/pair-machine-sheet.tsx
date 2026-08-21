"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Copy, Loader2 } from "lucide-react"
import { isDesktop, isTauri, tauriInvoke } from "@alook/shared"
import { CommunitySheet } from "@/components/community/shell/community-sheet"
import { Button } from "@/components/ui/button"
import { apiFetch, toastApiError } from "@/lib/api/client"
import { tid } from "@/lib/community/testids"
import { isLocalMode, WS_DO_PORT_DEFAULT } from "@/lib/utils"
import { websocketUrl } from "@/lib/websocket-url"

// Production daemons use their built-in endpoints. Local development appends
// the browser origin and local ws-do address so the command stays on the dev stack.
// Only ever called once `pendingTokenId` is set, which happens from a
// client-only effect — safe to touch `location` in the local branch.
function buildPairCommand(machineKey: string, machineId?: string): string {
  const isLocal = isLocalMode()
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
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pendingTokenId: string | null
  setPendingTokenId: (tokenId: string | null) => void
  connectedHostname: string | null
  mode?: PairMachineSheetMode
}) {
  const isReconnect = mode.kind === "reconnect"
  const [generating, setGenerating] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [started, setStarted] = useState(false)
  const [checkingRuntime, setCheckingRuntime] = useState(false)
  const [runtimeCapability, setRuntimeCapability] = useState<DaemonRuntimeCapability | null>(null)
  const [launchError, setLaunchError] = useState<string | null>(null)
  const generatedForKey = useRef<string | null>(null)
  const connectingRef = useRef(false)
  const desktopNative = isTauri() && isDesktop()

  const generate = useCallback(async () => {
    setGenerating(true)
    try {
      const endpoint =
        mode.kind === "reconnect"
          ? `/api/community/machines/${mode.machineId}/reconnect`
          : "/api/community/machines/pair"
      const res = await apiFetch<{ tokenId: string; expiresAt: string }>(
        endpoint,
        { method: "POST" }
      )
      setPendingTokenId(res.tokenId)
    } catch (err) {
      toastApiError(err, "Couldn't generate a key — try again.")
      console.error(err)
    } finally {
      setGenerating(false)
    }
  }, [setPendingTokenId, mode])

  // Auto-generate the key when the sheet opens. Track per-open so re-opens or
  // mode swaps trigger a fresh mint.
  const openKey = open
    ? mode.kind === "reconnect"
      ? `reconnect:${mode.machineId}`
      : "pair"
    : null
  useEffect(() => {
    if (!openKey) {
      generatedForKey.current = null
      return
    }
    if (generatedForKey.current === openKey) return
    generatedForKey.current = openKey
    setStarted(false)
    setPendingTokenId(null)
    void generate()
  }, [openKey, generate, setPendingTokenId])

  useEffect(() => {
    if (!open || !desktopNative) {
      setCheckingRuntime(false)
      setRuntimeCapability(null)
      return
    }
    let active = true
    setCheckingRuntime(true)
    setRuntimeCapability(null)
    setLaunchError(null)
    void tauriInvoke<DaemonRuntimeCapability>("daemon_runtime_capability")
      .then((capability) => {
        if (active) setRuntimeCapability(capability)
      })
      .catch((error) => {
        if (!active) return
        setRuntimeCapability({
          available: false,
          reason: nativeErrorMessage(
            error,
            "Alook couldn't check Node.js and npm on this computer.",
          ),
          nodeVersion: null,
        })
      })
      .finally(() => {
        if (active) setCheckingRuntime(false)
      })
    return () => {
      active = false
    }
  }, [open, desktopNative])

  const command = pendingTokenId
    ? buildPairCommand(
        pendingTokenId,
        mode.kind === "reconnect" ? mode.machineId : undefined,
      )
    : ""

  const copyCommand = useCallback(async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command)
      toast.success("Command copied")
    } catch {
      toast.error("Copy failed")
    }
  }, [command])

  const connectDesktop = useCallback(async () => {
    if (!pendingTokenId || connectingRef.current || !runtimeCapability?.available) return
    connectingRef.current = true
    setConnecting(true)
    setLaunchError(null)
    try {
      const result = await tauriInvoke<{ success: boolean; message: string }>("daemon_pair", {
        machineKey: pendingTokenId,
        machineId: mode.kind === "reconnect" ? mode.machineId : null,
      })
      if (!result.success) throw new Error(result.message || "The daemon did not start")
      setStarted(true)
      toast.success(isReconnect ? "Machine reconnected" : "This computer is connecting")
    } catch (error) {
      const message = nativeErrorMessage(
        error,
        "Couldn't start the daemon. Run the command below in a terminal instead.",
      )
      setLaunchError(message)
      toast.error(message)
    } finally {
      connectingRef.current = false
      setConnecting(false)
    }
  }, [pendingTokenId, runtimeCapability?.available, isReconnect, mode])

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
        <Button variant="secondary" onClick={requestClose}>
          Done
        </Button>
      )}
    >
          <PairMachineSteps
            command={command}
            generating={generating || !command}
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
}: {
  command: string
  generating: boolean
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
}) {
  return (
    <>
      <div data-motion-target={step1MotionTarget} className={step1ClassName}>
        <Step1
          command={command}
          generating={generating}
          onCopy={onCopy}
          headingAs={headingAs}
          desktopNative={desktopNative}
          checkingRuntime={checkingRuntime}
          runtimeCapability={runtimeCapability}
          launchError={launchError}
          connecting={connecting}
          started={started}
          onConnectDesktop={onConnectDesktop}
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
  onCopy,
  headingAs: Heading,
  desktopNative,
  checkingRuntime,
  runtimeCapability,
  launchError,
  connecting,
  started,
  onConnectDesktop,
}: {
  command: string
  generating: boolean
  onCopy: () => void
  headingAs: "h3" | "div"
  desktopNative: boolean
  checkingRuntime: boolean
  runtimeCapability: DaemonRuntimeCapability | null
  launchError: string | null
  connecting: boolean
  started: boolean
  onConnectDesktop?: () => void
}) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-center gap-2">
        <Marker n={1} done={!generating} />
        <Heading className="font-heading text-sm font-medium leading-tight tracking-[-0.015em] text-foreground">
          Run this on your machine
        </Heading>
      </header>
      <p className="text-sm text-muted-foreground">
        Open a terminal on the computer you want to connect, paste the command,
        and hit enter. Node.js with npm is required.
      </p>
      {generating ? (
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
          <span className="text-muted-foreground">is ready for your agent friends.</span>
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
