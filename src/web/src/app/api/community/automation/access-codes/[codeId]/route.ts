import { withAuth } from "@/lib/middleware/auth-policy"
import { AutomationAccessCodeUpdateSchema, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { automationManagementPolicy } from "@/lib/automation"
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers"

export const PATCH = withAuth(automationManagementPolicy, async (req, ctx) => {
  const [body, error] = await parseBody(req, AutomationAccessCodeUpdateSchema)
  if (error) return error
  const accessCode = await queries.automation.updateAccessCode(getPrimaryDb(ctx.env.DB), ctx.userId, ctx.params?.codeId ?? "", body)
  return accessCode ? writeJSON({ accessCode }) : writeError("Access code not found", 404)
})

export const DELETE = withAuth(automationManagementPolicy, async (_req, ctx) => {
  const deleted = await queries.automation.deleteAccessCode(getPrimaryDb(ctx.env.DB), ctx.userId, ctx.params?.codeId ?? "")
  return deleted ? writeJSON({ deleted: true }) : writeError("Access code not found", 404)
})
