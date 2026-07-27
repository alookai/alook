/**
 * Server API contract — the agent ⇄ server boundary.
 *
 * This file is now a thin re-export shim. The canonical definitions live in
 * `@alook/shared`'s `community-contract.ts` (lifted there so the real
 * server routes and the wake producer/consumer can share the exact same
 * types this CLI/production server pair implements against — see
 * `plans/community-agent-cli-bridge.md` §1). Keep importing from
 * `./contract.js` at existing daemon call sites; nothing else changes.
 */
export type {
  Id,
  UserId,
  AgentId,
  ServerId,
  ChannelId,
  MessageId,
  Seq,
  User,
  Agent,
  Server,
  ChannelKind,
  Channel,
  SenderType,
  Sender,
  Target,
  MessageContent,
  Message,
  AgentAttachmentRef,
  AgentAttachmentUploadResult,
  AgentAttachmentDownloadResult,
  AttachmentUploadRequest,
  AttachmentDownloadRequest,
  FileHandle,
  Cursor,
  Page,
  InboxFlag,
  InboxRow,
  InboxSnapshot,
  InboxPullRequest,
  InboxPullResponse,
  AckRequest,
  SendRequest,
  SendResponse,
  CommunityAgentReactAddResponse,
  ReadRequest,
  ResolveRequest,
  ListChannelsRequest,
  ChannelListItem,
  CategoryRef,
  ChannelGroup,
  ChannelMemberResult,
  ServerMember,
  ServerApi,
  FriendRequestResult,
  FriendCard,
  UnreadNotice,
  HostCommand,
  HostReadyRuntime,
  HostReady,
  SessionErrorFrame,
  HostControlChannel,
  AgentSessionReport,
  AgentActivityState,
  HostBotAuditEventFrame,
  BotAuditEventPayload,
  WebSocketLike,
  WebSocketFactory,
  AdminApi,
  EnrollmentApi,
  ServerApiError,
} from "@alook/shared/community-contract";

export {
  DM_SERVER,
  parseSeq,
  formatSeq,
} from "@alook/shared/community-contract";
