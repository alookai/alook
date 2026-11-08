import { createDb, queries } from "@alook/shared"
import type { RouterContext } from "../router-context"

export type MachineCommandForwarding =
  | { kind: "resolution-failed"; cause: unknown }
  | { kind: "forward-failed" }
  | { kind: "forwarded"; sent: number }

export async function forwardMachineCommand(
  env: RouterContext["env"], machineId: string, destination: string, frame: string,
): Promise<MachineCommandForwarding> {
  let doNames: string[]
  try {
    doNames = await queries.communityMachine.getActiveDoNamesForMachine(createDb(env.DB), machineId)
  } catch (cause) {
    return { kind: "resolution-failed", cause }
  }
  let sent = 0
  let transientFailure = false
  for (const doName of doNames) {
    try {
      const stub = env.WS_DO.get(env.WS_DO.idFromName("community-machine:" + doName))
      const response = await stub.fetch(new Request("http://internal" + destination, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: frame,
      }))
      if (!response.ok) { transientFailure = true; continue }
      const receipt = await response.json() as { sent?: unknown }
      if (typeof receipt.sent !== "number" || !Number.isFinite(receipt.sent) || receipt.sent < 0) {
        transientFailure = true
        continue
      }
      sent += receipt.sent
    } catch {
      transientFailure = true
    }
  }
  return sent === 0 && transientFailure ? { kind: "forward-failed" } : { kind: "forwarded", sent }
}
