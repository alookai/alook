import { AutomationAccessCodeCreateSchema, queries } from "@alook/shared"
import { getPrimaryDb } from "@/lib/db"
import { hashAutomationSecret, newAutomationSecret, withAutomationManagement } from "@/lib/automation"
import { parseBody, writeJSON } from "@/lib/middleware/helpers"

export const GET = withAutomationManagement(async (_req, ctx) => writeJSON({ accessCodes: await queries.automation.listAccessCodes(getPrimaryDb(ctx.env.DB), ctx.userId) }))

export const POST = withAutomationManagement(async (req, ctx) => {
  const [body, error] = await parseBody(req, AutomationAccessCodeCreateSchema)
  if (error) return error
  const secret = newAutomationSecret()
  const accessCode = await queries.automation.createAccessCode(getPrimaryDb(ctx.env.DB), ctx.userId, body, await hashAutomationSecret(secret))
  const response = writeJSON({ accessCode, secret }, 201)
  response.headers.set("Cache-Control", "no-store")
  return response
})
