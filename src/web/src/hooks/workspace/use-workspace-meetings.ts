"use client"

import { queryOptions,useMutation,useQuery } from "@tanstack/react-query"
import { useWorkspaceOwner,runWorkspaceRequest,type WorkspaceOwner } from "@/contexts/workspace-context"
import { assertApplicationOwner,captureApplicationOwner,runApplicationRequest } from "@/lib/application-owner"
import { listMeetings,createMeeting,stopMeeting,approveMeeting,deleteMeeting } from "@/lib/api"
import type { MeetingSession } from "@alook/shared"

function workspaceMeetingsOptions(owner: WorkspaceOwner, agentId: string) {
  return queryOptions({
    queryKey: owner.key("meetings", agentId),
    queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listMeetings(agentId, owner.workspaceId, options), signal),
    refetchInterval: (query) => query.state.data?.some((meeting) => meeting.status === "joining" || meeting.status === "recording") ? 5000 : false,
    refetchIntervalInBackground: false,
  })
}
type MeetingAction = { kind: "create"; data: Parameters<typeof createMeeting>[2]; assertUI: () => void } | { kind: "stop" | "approve" | "delete"; id: string; assertUI: () => void }
export function useWorkspaceMeetings(agentId: string) {
  const owner = useWorkspaceOwner()
  const options = workspaceMeetingsOptions(owner, agentId)
  const query = useQuery(options)
  const mutationKey = [...options.queryKey, "change"]
  const mutation = useMutation({
    mutationKey,
    scope: { id: JSON.stringify(mutationKey) },
    mutationFn: async (action: MeetingAction) => {
      action.assertUI()
      const original = captureApplicationOwner(owner.application)
      const resource = owner.queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true })
      await owner.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true })
      action.assertUI()
      const result = await runApplicationRequest<MeetingSession | void>(owner.application, (request) => {
        const qualified = { ...request, onUnauthorized: async () => {
          try { action.assertUI() } catch { return false }
          return request.onUnauthorized ? request.onUnauthorized() : false
        } }
        if (action.kind === "create") return createMeeting(agentId, owner.workspaceId, action.data, qualified)
        if (action.kind === "stop") return stopMeeting(agentId, action.id, owner.workspaceId, qualified)
        if (action.kind === "approve") return approveMeeting(agentId, action.id, owner.workspaceId, qualified)
        return deleteMeeting(agentId, action.id, owner.workspaceId, qualified)
      })
      assertApplicationOwner(original)
      if (resource && owner.queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true }) === resource) {
        await owner.queryClient.cancelQueries({ queryKey: options.queryKey, exact: true })
        assertApplicationOwner(original)
        if (owner.queryClient.getQueryCache().find({ queryKey: options.queryKey, exact: true }) === resource) {
          owner.queryClient.setQueryData<MeetingSession[]>(options.queryKey, (rows) => {
            if (action.kind === "delete") return rows?.filter((row) => row.id !== action.id)
            if (!result) return rows
            const current = rows ?? []
            return current.some((row) => row.id === result.id) ? current.map((row) => row.id === result.id ? result : row) : [result, ...current]
          })
          await owner.queryClient.invalidateQueries({ queryKey: options.queryKey, exact: true, refetchType: "none" })
        }
      }
      return result
    },
  })
  return { ...query, mutation, isCommandPending: () => owner.queryClient.isMutating({ mutationKey, exact: true }) > 0 }
}
