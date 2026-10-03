import { queryOptions } from "@tanstack/react-query"
import type { WsMessage } from "@alook/shared"
import { requestWorkspaceBrowse } from "@/lib/api"
import { captureWorkspaceOwner, assertWorkspaceOwner, workspaceRequestOptions, type WorkspaceOwner } from "@/contexts/workspace-context"

type FileReceipt = Extract<WsMessage, { type: "workspace.files" }>
type Subscribe = (callback: (message: WsMessage) => void) => () => void

export function workspaceFileOptions(owner: WorkspaceOwner, agentId: string, runtimeId: string | null, mode: "tree" | "read", path: string, subscribe: Subscribe) {
  return queryOptions({
    queryKey: owner.key("agent-files", agentId, runtimeId, mode, path),
    staleTime: mode === "tree" ? 30_000 : 0,
    gcTime: mode === "tree" ? 300_000 : 0,
    retry: false,
    queryFn: ({ signal }) => {
      const token = captureWorkspaceOwner(owner)
      const assert = () => assertWorkspaceOwner(token, signal)
      assert()
      return new Promise<FileReceipt["result"]>((resolve, reject) => {
        let requestId: string | null = null
        let settled = false
        const early: FileReceipt[] = []
        const complete = (error: unknown, result?: FileReceipt["result"]) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          signal.removeEventListener("abort", abort)
          unsubscribe()
          try { assert() } catch (retired) { reject(retired); return }
          if (error) reject(error)
          else resolve(result!)
        }
        const receive = (receipt: FileReceipt) => {
          if (receipt.requestId !== requestId) return
          complete(receipt.result.error ? new Error(receipt.result.error) : null, receipt.result)
        }
        const unsubscribe = subscribe((message) => {
          if (message.type !== "workspace.files" || message.agentId !== agentId) return
          if (requestId === null) { early.push(message); return }
          receive(message)
        })
        const abort = () => complete(new DOMException("Cancelled file read", "AbortError"))
        const timer = setTimeout(() => complete(new Error("Request timed out — daemon may be offline")), 15_000)
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) { abort(); return }
        void requestWorkspaceBrowse(agentId, owner.workspaceId, mode, path, workspaceRequestOptions(token, signal)).then((response) => {
          if (settled) return
          try { assert() } catch (error) { complete(error); return }
          requestId = response.request_id
          for (const receipt of early) receive(receipt)
          early.length = 0
        }, (error) => complete(error))
      })
    },
  })
}
