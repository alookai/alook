import { withAuth } from "@/lib/middleware/auth-policy"
import { automationPolicy } from "@/lib/automation"
import { discoverRuntimeModels, discoveryFailure } from "@/lib/community/discover-models.server"
import { projectModelOptions } from "@/lib/community/machine-options.server"
import { writeJSON } from "@/lib/middleware/helpers"

export const POST = withAuth(automationPolicy("machine.read"), async (req, ctx) => {
  const id = ctx.params?.id as string
  const response = await discoverRuntimeModels(req, ctx, true, (message, status) => discoveryFailure(message, status, id))
  if (response instanceof Response) return response
  return writeJSON({ ...projectModelOptions(id, { id: response.backendId, ...(response.result.catalog ? { reasoning: response.result.catalog } : {}) }, null, { includeCatalogMetadata: false }), source: response.source, observedAt: response.observedAt, requestId: response.requestId })
})
