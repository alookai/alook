import { nanoid } from "nanoid"
import { createDb, queries, parseEmailHandle, DEV_WEB_URL, createLogger } from "@alook/shared"

const log = createLogger({ service: "email" })

interface EmailEnv {
  DB: D1Database
  EMAIL_BUCKET: R2Bucket
  WEB_SERVICE: Fetcher
}

async function notifyWeb(env: EmailEnv, payload: Record<string, unknown>, traceId: string) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Trace-Id": traceId,
  }

  try {
    const res = await env.WEB_SERVICE.fetch("http://internal/api/email/notify", {
      method: "POST",
      headers,
      body,
    })
    if (!res.ok) throw new Error(`WEB_SERVICE responded ${res.status}`)
  } catch (err) {
    log.warn("WEB_SERVICE notify failed, falling back to DEV_WEB_URL", { err })
    await fetch(`${DEV_WEB_URL}/api/email/notify`, {
      method: "POST",
      headers,
      body,
    })
  }
}

export default {
  async email(message: ForwardableEmailMessage, env: EmailEnv): Promise<void> {
    const traceId = nanoid(12)
    const emailLog = log.child({ traceId, from: message.from, to: message.to })

    const db = createDb(env.DB)
    const handle = parseEmailHandle(message.to)

    const agent = await queries.agent.getAgentByHandle(db, handle)
    if (!agent) {
      emailLog.warn("no agent found", { handle })
      message.setReject("No agent found for this address")
      return
    }

    emailLog.info("email received", { agentId: agent.id, handle })

    const whitelisted = await queries.whitelist.isWhitelisted(db, agent.id, agent.workspaceId, message.from)

    const rawBytes = await new Response(message.raw).arrayBuffer()
    const r2Id = nanoid()
    const r2Key = `emails/${r2Id}/raw`
    await env.EMAIL_BUCKET.put(r2Key, rawBytes, {
      httpMetadata: { contentType: "message/rfc822" },
    })

    const subject = message.headers.get("subject") ?? ""

    if (whitelisted) {
      emailLog.info("whitelisted email, notifying web", { agentId: agent.id })
      await notifyWeb(env, {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        r2Key,
        from: message.from,
        to: message.to,
        subject,
        isWhitelisted: true,
      }, traceId)
    } else {
      const forwardToEmail = agent.forwardToEmail ?? ""
      let forwardAddress = forwardToEmail

      if (!forwardAddress) {
        const agentUser = agent.ownerId ? await queries.user.getUser(db, agent.ownerId) : null
        forwardAddress = agentUser?.email ?? ""
      }

      const forwarded = !!forwardAddress

      emailLog.info("non-whitelisted email, notifying web", { agentId: agent.id, forwarded })
      await notifyWeb(env, {
        agentId: agent.id,
        workspaceId: agent.workspaceId,
        r2Key,
        from: message.from,
        to: message.to,
        subject,
        isWhitelisted: false,
        forwarded,
      }, traceId)

      if (forwardAddress) {
        emailLog.info("forwarding email", { forwardTo: forwardAddress })
        await message.forward(forwardAddress)
      }
    }
  },
}
