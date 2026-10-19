"use client"

import { useEffect, useRef } from "react"
import { useAtom, useCreateAtom } from "@tanstack/react-store"
import { useMutation } from "@tanstack/react-query"
import { isMobile, isTauri } from "@alook/shared"
import QrScanner from "qr-scanner"
import { useCommunityViewSource } from "@/hooks/community/use-community-view-source"
import { isAbortError } from "@/lib/errors"
import { parseTouchSetupQr, touchSetupGuard, type TouchNetwork, type TouchSetupQr, type TouchSetupTransport } from "@/lib/touch-setup"
import { browserTouchSetupAvailable, createBrowserTouchSetup } from "@/lib/touch-setup-browser"
import { createNativeTouchSetup } from "@/lib/native-touch-setup"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

type Attempt = { controller: AbortController; transport: TouchSetupTransport; assert: () => void }
type SetupState = { phase: "scan" | "selected" | "connecting" | "networks" | "provisioning" | "code" | "error"; qr: TouchSetupQr | null; networks: TouchNetwork[]; error: string }

function closeCamera(scanner: QrScanner | null) {
  if (!scanner) return
  void scanner.pause(true)
  scanner.destroy()
  scanner.$video.remove()
}

function pause(signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    signal.throwIfAborted()
    const abort = () => { clearTimeout(timer); reject(new DOMException("Touch setup cancelled", "AbortError")) }
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, 1000)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export function TouchSetup({ userId, onCode, onClose }: { userId: string; onCode: (code: string) => void; onClose: () => void }) {
  const source = useCommunityViewSource(`touch-setup:${userId}`)
  const cameraHost = useRef<HTMLDivElement>(null)
  const runtime = useRef<{ scanner: QrScanner | null; attempt: Attempt | null }>({ scanner: null, attempt: null })
  const [state, setState] = useAtom(useCreateAtom<SetupState>({ phase: "scan", qr: null, networks: [], error: "" }))
  const [ssid, setSsid] = useAtom(useCreateAtom(""))
  const [password, setPassword] = useAtom(useCreateAtom(""))
  const native = isTauri() && isMobile()
  const available = native || browserTouchSetupAvailable()
  const command = useMutation({
    meta: { observabilityAction: "device.setup.command" },
    mutationKey: ["community", "touch-setup", userId], retry: false, gcTime: 0,
    mutationFn: async ({ run }: { attempt: Attempt; run: () => Promise<void> }) => {
      try { await run() } catch (error) {
        if (isAbortError(error)) throw new DOMException("Touch setup cancelled", "AbortError")
        throw new Error("Touch setup failed.")
      }
    },
    onError: (error, { attempt }) => {
      if (isAbortError(error) || runtime.current.attempt !== attempt) return
      try { attempt.assert() } catch { return }
      runtime.current.attempt?.controller.abort()
      setPassword("")
      setState(previous => ({ ...previous, phase: "error", error: "Could not complete Touch setup. Check Bluetooth, the Wi-Fi password, and the code on your Touch, then try again." }))
    },
  })

  useEffect(() => () => {
    closeCamera(runtime.current.scanner); runtime.current.scanner = null
    runtime.current.attempt?.controller.abort(); runtime.current.attempt = null
  }, [runtime])

  useEffect(() => {
    if (!available || state.phase !== "scan" || !cameraHost.current) return
    const current = runtime.current
    const original = source.capture()
    let accepted = false
    const preview = document.createElement("video")
    preview.muted = true; preview.playsInline = true
    preview.className = "aspect-square w-full rounded-lg bg-muted object-cover"
    preview.setAttribute("aria-label", "Scan Touch setup code")
    cameraHost.current.replaceChildren(preview)
    const scanner = new QrScanner(preview, result => {
      if (accepted) return
      try {
        original()
        const qr = parseTouchSetupQr(result.data)
        accepted = true; closeCamera(scanner); runtime.current.scanner = null
        const controller = new AbortController()
        const signal = AbortSignal.any([original.signal, controller.signal])
        const transport = native ? createNativeTouchSetup(qr, signal, original) : createBrowserTouchSetup(qr, signal, original)
        runtime.current.attempt = { controller, transport, assert: touchSetupGuard(signal, original) }
        setState({ phase: "selected", qr, networks: [], error: "" })
      } catch (error) {
        if (!isAbortError(error)) setState(previous => ({ ...previous, error: "Scan the setup code shown on your Touch." }))
      }
    }, { preferredCamera: "environment", maxScansPerSecond: 8, returnDetailedScanResult: true })
    current.scanner = scanner
    void scanner.start().catch(() => {
      if (accepted) return
      try { original() } catch { return }
      setState(previous => ({ ...previous, phase: "error", error: "Camera access is unavailable. Allow camera access, or use the device code below." }))
    })
    return () => { accepted = true; closeCamera(scanner); if (current.scanner === scanner) current.scanner = null }
  }, [available, native, runtime, setState, source, state.phase])

  const connect = () => {
    const attempt = runtime.current.attempt
    if (!attempt || state.phase !== "selected" || command.isPending) return
    attempt.assert()
    const connection = attempt.transport.connect()
    setState(previous => ({ ...previous, phase: "connecting", error: "" }))
    command.mutate({ attempt, run: async () => {
      await connection; attempt.assert()
      const networks = await attempt.transport.scanNetworks(); attempt.assert()
      setSsid(networks[0]?.ssid ?? "")
      setState(previous => ({ ...previous, phase: "networks", networks }))
    } })
  }
  const provision = () => {
    const attempt = runtime.current.attempt, network = state.networks.find(row => row.ssid === ssid)
    if (!attempt || !network || state.phase !== "networks" || command.isPending) return
    attempt.assert()
    const secret = password; setPassword("")
    setState(previous => ({ ...previous, phase: "provisioning", error: "" }))
    command.mutate({ attempt, run: async () => {
      await attempt.transport.provision(network, secret); attempt.assert()
      setState(previous => ({ ...previous, phase: "code" }))
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        attempt.assert()
        const grant = await attempt.transport.exchangeEndpoint("code"); attempt.assert()
        if (grant.state === "ready") {
          const acknowledged = await attempt.transport.exchangeEndpoint("ack", grant.user_code); attempt.assert()
          if (acknowledged.state !== "ready" || acknowledged.user_code !== grant.user_code) throw new Error("Touch code changed. Start setup again.")
          await attempt.transport.cancel(); attempt.assert()
          onCode(grant.user_code)
          return
        }
        await pause(AbortSignal.any([source.signal, attempt.controller.signal]))
      }
      throw new Error("Touch authorization timed out.")
    } })
  }

  return <section className="space-y-4" data-testid="touch-setup">
    <div className="flex items-center justify-between gap-4"><h2 className="font-medium">Add Touch</h2><Button variant="ghost" onClick={() => { runtime.current.attempt?.controller.abort(); closeCamera(runtime.current.scanner); runtime.current.scanner = null; onClose() }}>Cancel setup</Button></div>
    {!available ? <p>This browser cannot connect to Touch by Bluetooth. Use a supported Chrome browser or the Alook mobile app. You can still enter the device code below.</p> : <>
      {state.phase === "scan" && <><p className="text-sm text-muted-foreground">Point the camera at the setup code on your Touch.</p><div ref={cameraHost} /></>}
      {state.qr && <p>{state.qr.name}</p>}
      {state.phase === "selected" && <Button onClick={connect}>Connect Touch</Button>}
      {state.phase === "connecting" && <p role="status">Connecting to Touch…</p>}
      {state.phase === "networks" && <form className="space-y-4" onSubmit={event => { event.preventDefault(); provision() }}>
        <label className="flex flex-col gap-2 text-sm">Wi-Fi network<select aria-label="Wi-Fi network" className="h-11 rounded-md border bg-background px-4" value={ssid} onChange={event => { setSsid(event.target.value); setPassword("") }}>{state.networks.map(network => <option key={network.ssid} value={network.ssid}>{network.ssid}{network.secured ? "" : " (open)"}</option>)}</select></label>
        {state.networks.find(network => network.ssid === ssid)?.secured && <label className="flex flex-col gap-2 text-sm">Wi-Fi password<Input type="password" autoComplete="off" aria-label="Wi-Fi password" value={password} onChange={event => setPassword(event.target.value)} /></label>}
        {!state.networks.length && <p>No Wi-Fi networks found. Check your router and try setup again.</p>}
        <Button type="submit" disabled={!ssid || command.isPending}>Connect Wi-Fi</Button>
      </form>}
      {(state.phase === "provisioning" || state.phase === "code") && <p role="status">{state.phase === "provisioning" ? "Connecting Touch to Wi-Fi…" : "Getting the device code…"}</p>}
    </>}
    {state.error && <p role="alert" className="text-sm text-destructive">{state.error}</p>}
  </section>
}
