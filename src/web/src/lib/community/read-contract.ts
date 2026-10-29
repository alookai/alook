import { NextResponse } from "next/server"
import {
  COMMUNITY_CONTRACT_HEADER, COMMUNITY_CONTRACT_VERSION, type CommunityContract, communityReadSchemas, communityChannelResourceFromStorage, CommunityMessageResourceSchema,
  CommunityConversationEntryReadSchema, CommunityMessagesReadSchema,
  type CommunityAccessDecision, type CommunityMessageSurfaceReceipt, type CommunityMessagesRead,
  type CommunityConversationEntryRead,
} from "@alook/shared"

function versionedJSON(data: unknown, contract: CommunityContract = COMMUNITY_CONTRACT_VERSION): NextResponse {
  return NextResponse.json(data, { headers: { [COMMUNITY_CONTRACT_HEADER]: String(contract) } })
}

export function writeCommunityChannelRead(_request: Request, channelId: string, channel: unknown,
  access: Omit<CommunityAccessDecision, "channelId">) {
  const contract = COMMUNITY_CONTRACT_VERSION
  return versionedJSON(communityReadSchemas(contract).channel.parse({ contractVersion: contract, channelId,
    channel: communityChannelResourceFromStorage(channel),
    access: { channelId, ...access } }), contract)
}

export type MessagePage = Pick<CommunityMessagesRead["page"], "latestSeq"> & Partial<{ [Field in Exclude<keyof CommunityMessagesRead["page"], "latestSeq">]: NonNullable<CommunityMessagesRead["page"][Field]> }> & {
  messages: unknown[]
  profiles: CommunityMessagesRead["profiles"]
  cursor?: NonNullable<CommunityMessagesRead["page"]["olderCursor"]>
  hasMore?: CommunityMessagesRead["page"]["hasMoreOlder"]
  surfaceReceipt: CommunityMessageSurfaceReceipt
}

export function writeCommunityMessagesRead(_request: Request, channelId: string, page: MessagePage) {
  const contract = COMMUNITY_CONTRACT_VERSION
  return versionedJSON(communityReadSchemas(contract).messages.parse(messageReadPayload(channelId, page, contract)), contract)
}

function messageReadPayload(channelId: string, page: MessagePage, contract: CommunityContract) {
  return { contractVersion: contract, channelId,
    profiles: page.profiles,
    messages: page.messages.map((message) => CommunityMessageResourceSchema.parse(message)),
    page: { olderCursor: page.olderCursor ?? page.cursor ?? null, newerCursor: page.newerCursor ?? null,
      hasMoreOlder: page.hasMoreOlder ?? page.hasMore ?? false, hasMoreNewer: page.hasMoreNewer ?? false,
      latestSeq: page.latestSeq }, surfaceReceipt: page.surfaceReceipt }
}

export function communityMessagesReadFromPage(channelId: string, page: MessagePage) {
  return CommunityMessagesReadSchema.parse(messageReadPayload(channelId, page, COMMUNITY_CONTRACT_VERSION))
}

export function writeCommunityConversationEntryRead(entry: CommunityConversationEntryRead) {
  return versionedJSON(CommunityConversationEntryReadSchema.parse(entry), COMMUNITY_CONTRACT_VERSION)
}

export { versionedJSON as writeCommunityContractJSON }
