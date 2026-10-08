import { NextResponse } from "next/server"
import {
  COMMUNITY_CONTRACT_HEADER, requestsCommunityContractV2,
  CommunityChannelReadSchema, CommunityMessagesReadSchema, CommunityReadStateReadSchema,
  normalizeCommunityChannelResource, normalizeCommunityMessageResource,
  type CommunityAccessDecision, type CommunityReadStateResource, type CommunityMessageSurfaceReceipt, type CommunityMessagesRead,
} from "@alook/shared"
import { writeJSON } from "@/lib/middleware/helpers"

function versionedJSON(data: unknown): NextResponse {
  return NextResponse.json(data, { headers: { [COMMUNITY_CONTRACT_HEADER]: "2" } })
}

export function writeCommunityChannelRead(request: Request, channelId: string, channel: unknown,
  access: Omit<CommunityAccessDecision, "channelId">) {
  if (!requestsCommunityContractV2(request.headers)) return writeJSON(channel)
  return versionedJSON(CommunityChannelReadSchema.parse({ contractVersion: 2, channelId,
    channel: normalizeCommunityChannelResource(channel), access: { channelId, ...access } }))
}

type MessagePage = Pick<CommunityMessagesRead["page"], "latestSeq"> & Partial<{ [Field in Exclude<keyof CommunityMessagesRead["page"], "latestSeq">]: NonNullable<CommunityMessagesRead["page"][Field]> }> & {
  messages: unknown[]
  cursor?: NonNullable<CommunityMessagesRead["page"]["olderCursor"]>
  hasMore?: CommunityMessagesRead["page"]["hasMoreOlder"]
  surfaceReceipt: CommunityMessageSurfaceReceipt
}

export function writeCommunityMessagesRead(request: Request, channelId: string, page: MessagePage) {
  if (!requestsCommunityContractV2(request.headers)) return writeJSON(page)
  return versionedJSON(CommunityMessagesReadSchema.parse({ contractVersion: 2, channelId,
    messages: page.messages.map((message) => normalizeCommunityMessageResource(message, channelId)),
    page: { olderCursor: page.olderCursor ?? page.cursor ?? null, newerCursor: page.newerCursor ?? null,
      hasMoreOlder: page.hasMoreOlder ?? page.hasMore ?? false, hasMoreNewer: page.hasMoreNewer ?? false,
      latestSeq: page.latestSeq }, surfaceReceipt: page.surfaceReceipt }))
}

export function writeCommunityReadState(request: Request, channelId: string,
  state: Omit<CommunityReadStateResource, "channelId">) {
  if (!requestsCommunityContractV2(request.headers)) return writeJSON(state)
  return versionedJSON(CommunityReadStateReadSchema.parse({ contractVersion: 2, channelId, readState: { channelId, ...state } }))
}

export { versionedJSON as writeCommunityContractJSON }
