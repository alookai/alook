/**
 * Server API contract — the agent ⇄ server boundary.
 *
 * This file is now a thin re-export shim. The canonical definitions live in
 * `@alook/shared`'s `community-cli-contract.ts` (lifted there so the real
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
  ChannelRef,
  Target,
  MessageContent,
  Message,
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
  ReadRequest,
  ResolveRequest,
  ListChannelsRequest,
  ChannelListItem,
  ServerMember,
  ServerApi,
  UnreadNotice,
  HostCommand,
  HostReadyRuntime,
  HostReady,
  SessionErrorFrame,
  HostControlChannel,
  AgentSessionReport,
  WebSocketLike,
  WebSocketFactory,
  AdminApi,
  EnrollmentApi,
  ServerApiError,
  ParsedRef,
} from "@alook/shared/community-cli-contract";

export {
  DM_SERVER,
  parseRef,
  formatRef,
  parseSeq,
  formatSeq,
} from "@alook/shared/community-cli-contract";
