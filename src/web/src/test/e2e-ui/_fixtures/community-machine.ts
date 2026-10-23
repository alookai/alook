import { createRequire } from "node:module"
import { resolve } from "node:path"
import { expect } from "@playwright/test"
import type { CommunityMachineSummary } from "@alook/shared"
import type { CaseResources } from "./case-fixture"
import { MACHINE_WS_URL, REPO_ROOT, WEB_URL } from "../_setup/paths"

type MachineSocket = {
  send: (data: string) => void
  close: () => void
  readonly readyState: number
  once(event: "close", listener: () => void): void
  once(event: "open", listener: () => void): void
  once(event: "error", listener: (error: Error) => void): void
  on(event: "error", listener: (error: Error) => void): void
  on(event: "message", listener: (data: unknown) => void): void
  off(event: "message", listener: (data: unknown) => void): void
}

export function connectMachine(credential: string, resources: CaseResources, scope: { machineId: string; headers: Record<string, string> }) {
  const requireFromDaemon = createRequire(resolve(REPO_ROOT, "src/daemon/package.json"))
  const { WebSocket } = requireFromDaemon("ws") as {
    WebSocket: new (url: string, options: { headers: Record<string, string> }) => MachineSocket
  }
  const socket = new WebSocket(MACHINE_WS_URL.replace(/^http/, "ws"), {
    headers: { Authorization: `Bearer ${credential}` },
  })
  const closed = new Promise<void>(resolveClose => socket.once("close", resolveClose))
  const owner = resources.own(socket, async captured => {
    if (captured.readyState !== 3) captured.close()
    await closed
  })
  let failure: Error | undefined
  socket.on("error", error => { failure = error })
  socket.on("message", data => {
    const frame = JSON.parse(String(data)) as { type: string; nonce?: string }
    if (frame.type === "machine:heartbeat") socket.send(JSON.stringify({ type: "machine_heartbeat_ack", nonce: frame.nonce }))
  })
  const opened = new Promise<void>((resolveOpen, reject) => {
    socket.once("open", resolveOpen)
    socket.once("error", reject)
    socket.once("close", () => reject(new Error("Machine socket closed before ready")))
  })
  const readMachine = async () => {
    const response = await fetch(`${WEB_URL}/api/community/machines`, { headers: scope.headers })
    expect(response.status).toBe(200)
    const body = await response.json() as { machines: CommunityMachineSummary[] }
    return body.machines.find(machine => machine.id === scope.machineId)
  }
  return {
    socket,
    close: () => owner.close(),
    opened: (async () => {
      await opened
      const machine = await readMachine()
      if (!machine) throw new Error("Owned machine missing before ready")
      const { hostname, platform, arch, osRelease, daemonVersion, availableRuntimes } = machine
      socket.send(JSON.stringify({ type: "ready", hostname, platform, arch, osRelease, daemonVersion,
        runtimeReport: availableRuntimes, runningAgents: [], capabilities: ["control-heartbeat-v1"] }))
      await expect.poll(async () => {
        if (failure) throw failure
        expect(socket.readyState).toBe(1)
        return (await readMachine())?.status
      }).toBe("online")
    })(),
  }
}
