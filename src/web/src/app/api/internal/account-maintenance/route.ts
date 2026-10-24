import { getCloudflareContext } from "@opennextjs/cloudflare"
import { maintainAccounts } from "@/lib/account-maintenance"

export async function POST(request: Request) {
  if (request.headers.get("X-Alook-Internal") !== "1") return new Response(null, { status: 404 })
  const { env, ctx } = await getCloudflareContext({ async: true })
  await maintainAccounts(env, ctx)
  return Response.json({ ok: true })
}
