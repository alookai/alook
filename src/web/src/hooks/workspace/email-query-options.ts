import { queryOptions,useQueries,skipToken } from "@tanstack/react-query"
import type { Email } from "@alook/shared"
import { captureQueryReceipt,isQueryReceiptCurrent,withQueryReceipt,reconcileQueryReceipt } from "@/lib/query-receipt"
import { getEmailBody,getEmailThread,listEmails } from "@/lib/api"
import { captureWorkspaceOwner,assertWorkspaceOwner,workspaceRequestOptions,runWorkspaceRequest,type WorkspaceOwner } from "@/contexts/workspace-context"

export const emailEntityKey = (owner: WorkspaceOwner, id: string) => owner.key("email", "entity", id)
export const emailBodyOptions = (owner: WorkspaceOwner, id: string) => queryOptions({
  queryKey: owner.key("email", "body", id), gcTime: 0,
  structuralSharing: reconcileQueryReceipt,
  queryFn: async ({ signal }) => {
    const receipt = captureQueryReceipt(owner.queryClient, owner.key("email", "body", id))
    const data = await runWorkspaceRequest(owner, (options) => getEmailBody(id, owner.workspaceId, options), signal)
    return withQueryReceipt(data, receipt)
  },
})

function seedEmail(owner: WorkspaceOwner, email: Email) {
  const { html_body, ...fields } = email
  const canonical: Email = { ...fields, html_body: "" }
  owner.queryClient.setQueryData<Email | null>(emailEntityKey(owner, email.id), canonical)
  if (html_body) owner.queryClient.setQueryData(emailBodyOptions(owner, email.id).queryKey, { content: html_body, isHtml: true })
}

function emailWindowOptions(owner: WorkspaceOwner, key: readonly unknown[], load: (options: ReturnType<typeof workspaceRequestOptions>) => Promise<Email[]>) {
  return queryOptions({ queryKey: key,
    queryFn: async ({ signal }) => {
      const token = captureWorkspaceOwner(owner)
      const baseline = new Map(owner.queryClient.getQueryCache().findAll({ queryKey: owner.key("email", "entity") }).map((query) => [query.queryKey.at(-1), captureQueryReceipt(owner.queryClient, query.queryKey)]))
      const bodies = new Map(owner.queryClient.getQueryCache().findAll({ queryKey: owner.key("email", "body") }).map((query) => [query.queryKey.at(-1), captureQueryReceipt(owner.queryClient, query.queryKey)]))
      const assert = () => assertWorkspaceOwner(token, signal)
      assert()
      try {
        const rows = await load(workspaceRequestOptions(token, signal))
        assert()
        for (const row of rows) {
          const receipt = baseline.get(row.id), current = owner.queryClient.getQueryCache().find({ queryKey: emailEntityKey(owner, row.id), exact: true })
          if (receipt ? isQueryReceiptCurrent(receipt) : !current) {
            const bodyReceipt = bodies.get(row.id), body = owner.queryClient.getQueryCache().find({ queryKey: emailBodyOptions(owner, row.id).queryKey, exact: true })
            const bodyCurrent = bodyReceipt ? isQueryReceiptCurrent(bodyReceipt) : !body
            seedEmail(owner, { ...row, html_body: bodyCurrent ? row.html_body : "" })
          }
        }
        return { ids: rows.map((row) => row.id) }
      } catch (error) { assert(); throw error }
    },
  })
}

export function emailListOptions(owner: WorkspaceOwner, agentId: string, folder: string, address?: string) {
  return emailWindowOptions(owner, owner.key("email", "windows", "list", agentId, folder, address ?? ""), (options) => listEmails(agentId, owner.workspaceId, folder, address, options))
}
export function emailThreadOptions(owner: WorkspaceOwner, id: string) {
  return emailWindowOptions(owner, owner.key("email", "windows", "thread", id), (options) => getEmailThread(id, owner.workspaceId, options))
}
export function useEmailRows(owner: WorkspaceOwner, ids: readonly string[]) {
  return useQueries({ queries: ids.map((id) => ({ queryKey: emailEntityKey(owner, id), queryFn: skipToken, enabled: false, structuralSharing: reconcileQueryReceipt })) }).flatMap((query) => query.data ? [query.data as Email] : [])
}
