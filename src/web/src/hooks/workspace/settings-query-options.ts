import { queryOptions } from "@tanstack/react-query"
import { listMembers, listInvites, listWorkspaces, listWhitelist, listAgentAccess, fetchModelOptions, getMinCliVersion, fetchLatestCliVersion } from "@/lib/api"
import { applicationKey, runApplicationRequest } from "@/lib/application-owner"
import { runWorkspaceRequest, type WorkspaceOwner } from "@/contexts/workspace-context"

export function workspaceMembersOptions(owner: WorkspaceOwner) {
  return queryOptions({ queryKey: owner.key("members"), queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listMembers(owner.workspaceId, options), signal) })
}
export function applicationWorkspacesOptions(owner: WorkspaceOwner["application"]) {
  return queryOptions({ queryKey: applicationKey(owner, "workspaces"), queryFn: ({ signal }) => runApplicationRequest(owner, listWorkspaces, signal) })
}
export function workspaceInvitesOptions(owner: WorkspaceOwner) {
  return queryOptions({ queryKey: owner.key("invites"), queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listInvites(owner.workspaceId, options), signal) })
}
export function agentWhitelistOptions(owner: WorkspaceOwner, agentId: string) {
  return queryOptions({ queryKey: owner.key("agent-whitelist", agentId), queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listWhitelist(agentId, owner.workspaceId, options), signal) })
}
export function agentAccessOptions(owner: WorkspaceOwner, agentId: string) {
  return queryOptions({ queryKey: owner.key("agent-access", agentId), queryFn: ({ signal }) => runWorkspaceRequest(owner, (options) => listAgentAccess(owner.workspaceId, agentId, options), signal) })
}
export function modelCatalogOptions(owner: WorkspaceOwner) {
  return queryOptions({ queryKey: applicationKey(owner.application, "model-options"), staleTime: 300_000, queryFn: ({ signal }) => runApplicationRequest(owner.application, fetchModelOptions, signal) })
}
export function minCliVersionOptions(owner: WorkspaceOwner) {
  return queryOptions({ queryKey: applicationKey(owner.application, "min-cli-version"), staleTime: 300_000, queryFn: ({ signal }) => runApplicationRequest(owner.application, getMinCliVersion, signal) })
}

export function latestCliVersionOptions(owner: WorkspaceOwner) {
  return queryOptions({ queryKey: applicationKey(owner.application, "latest-cli-version"), staleTime: 300_000, queryFn: ({ signal }) => runApplicationRequest(owner.application, fetchLatestCliVersion, signal) })
}
