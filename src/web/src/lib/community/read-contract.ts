import { NextResponse } from "next/server"
import {
  COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION, requestedCommunityContract, communityReadSchemas, communityChannelResourceFromStorage, CommunityMessageResourceSchema,
  normalizeCommunityChannelResource, normalizeCommunityMessageResource, CommunityConversationEntryReadSchema, CommunityMessagesReadSchema,
  type CommunityAccessDecision, type CommunityMessageSurfaceReceipt, type CommunityMessagesRead,
  type CommunityConversationEntryRead,
} from "@alook/shared"
import { writeJSON } from "@/lib/middleware/helpers"

function versionedJSON(data: unknown, contract: 2 | 3 = COMMUNITY_CONTRACT_VERSION): NextResponse {
  return NextResponse.json(data, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(contract) } })
}

export function writeCommunityChannelRead(request: Request, channelId: string, channel: unknown,
  access: Omit<CommunityAccessDecision, "channelId">) {
  const contract = requestedCommunityContract(request.headers)
  if (contract !== 2 && contract !== 3) return writeJSON(channel)
  return versionedJSON(communityReadSchemas(contract).channel.parse({ contractVersion: contract, channelId,
    channel: contract === 3 ? communityChannelResourceFromStorage(channel) : normalizeCommunityChannelResource(channel),
    access: { channelId, ...access } }), contract)
}

export type MessagePage = Pick<CommunityMessagesRead["page"], "latestSeq"> & Partial<{ [Field in Exclude<keyof CommunityMessagesRead["page"], "latestSeq">]: NonNullable<CommunityMessagesRead["page"][Field]> }> & {
  messages: unknown[]
  cursor?: NonNullable<CommunityMessagesRead["page"]["olderCursor"]>
  hasMore?: CommunityMessagesRead["page"]["hasMoreOlder"]
  surfaceReceipt: CommunityMessageSurfaceReceipt
}

export function writeCommunityMessagesRead(request: Request, channelId: string, page: MessagePage) {
  const contract = requestedCommunityContract(request.headers)
  if (contract !== 2 && contract !== 3) return writeJSON(page)
  return versionedJSON(communityReadSchemas(contract).messages.parse(messageReadPayload(channelId, page, contract)), contract)
}

function messageReadPayload(channelId: string, page: MessagePage, contract: 2 | 3) {
  return { contractVersion: contract, channelId,
    messages: page.messages.map((message) => contract === 3 ? CommunityMessageResourceSchema.parse(message) : normalizeCommunityMessageResource(message, channelId)),
    page: { olderCursor: page.olderCursor ?? page.cursor ?? null, newerCursor: page.newerCursor ?? null,
      hasMoreOlder: page.hasMoreOlder ?? page.hasMore ?? false, hasMoreNewer: page.hasMoreNewer ?? false,
      latestSeq: page.latestSeq }, surfaceReceipt: page.surfaceReceipt }
}

export function communityMessagesReadFromPage(channelId: string, page: MessagePage) {
  return CommunityMessagesReadSchema.parse(messageReadPayload(channelId, page, 3))
}

export function writeCommunityConversationEntryRead(entry: CommunityConversationEntryRead) {
  return versionedJSON(CommunityConversationEntryReadSchema.parse(entry), 3)
}

export { versionedJSON as writeCommunityContractJSON }
