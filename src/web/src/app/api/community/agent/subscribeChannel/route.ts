import { NextResponse, type NextRequest } from "next/server"
import { queries, CommunityAgentSubscribeChannelRequestSchema, parseRef, DM_SERVER } from "@alook/shared"
import { getDb } from "@/lib/db"
import { withAgentRunnerAuth } from "@/lib/middleware/community-agent-runner-auth"
import { resolveTargetForMember, resolveErrorResponse } from "@/lib/community/resolve-ref"
import { requireChannelMember } from "@/lib/community/permissions"

/**
 * POST /api/community/agent/subscribeChannel — `alook channel subscribe
 * <all|mentions> --channel <ref>`. Body `{ channel: string, level:
 * "all"|"mentions" }`. Sets the BOT'S OWN wake-notification level for one
 * channel/thread (never DMs — see daemon-channel-cli plan §Decisions #4).
 *
 * `level:"mentions"` upserts a channel-level `community_notification_setting`
 * row via `setChannelLevel`; `level:"all"` instead DELETES any existing
 * override via `removeChannelOverride` rather than writing an explicit "all"
 * row — fewer rows, identical effective behavior, since the wake filter
 * (`findWakeCandidates`) already treats "no row" as "all".
 */
export const POST = withAgentRunnerAuth(async (req: NextRequest, ctx) => {
  const db = getDb(ctx.env.DB)

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 })
  }
  const parsed = CommunityAgentSubscribeChannelRequestSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid payload", details: parsed.error.flatten() }, { status: 400 })
  }
  const body = parsed.data

  // Checked ahead of `resolveTargetForMember` — that helper's DM branch
  // returns a 404 ("dm not found") when no DM conversation exists yet
  // between the bot and the peer (since `createDmIfMissing` is false
  // here), which would otherwise mask this command's own "DMs not
  // supported" 400 for any peer the bot hasn't DM'd before. Checking the
  // ref's server segment directly avoids depending on that resolution at
  // all.
  let parsedRef: ReturnType<typeof parseRef>
  try {
    parsedRef = parseRef(body.channel)
  } catch {
    return NextResponse.json({ error: "malformed channel ref" }, { status: 400 })
  }
  if (parsedRef.server === DM_SERVER) {
    return NextResponse.json({ error: "channel subscribe does not support DMs" }, { status: 400 })
  }

  const resolved = await resolveTargetForMember(db, ctx.botUserId, body.channel, {
    createDmIfMissing: false,
    createThreadIfMissing: false,
    callerKind: "bot",
  })
  if ("error" in resolved) return resolveErrorResponse(resolved)

  if (resolved.kind === "dm") {
    return NextResponse.json({ error: "channel subscribe does not support DMs" }, { status: 400 })
  }

  const gate = await requireChannelMember(db, resolved.channelId, ctx.botUserId)
  if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status })

  if (body.level === "mentions") {
    await queries.communityNotificationSetting.setChannelLevel(db, {
      userId: ctx.botUserId,
      channelId: resolved.channelId,
      level: "mentions",
    })
  } else {
    await queries.communityNotificationSetting.removeChannelOverride(db, {
      userId: ctx.botUserId,
      channelId: resolved.channelId,
    })
  }

  return NextResponse.json({ channel: body.channel, level: body.level })
})
