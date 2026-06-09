import { NextRequest } from "next/server";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { CONVERSATION_TYPES, CreateBranchRequestSchema, queries } from "@alook/shared";
import { getDb } from "@/lib/db";
import { withAuth } from "@/lib/middleware/auth";
import { withWorkspaceMember } from "@/lib/middleware/workspace";
import { parseBody, writeError, writeJSON } from "@/lib/middleware/helpers";
import {
  conversationBranchToResponse,
  conversationToResponse,
} from "@/lib/api/responses";

const BRANCHABLE_PROVIDERS = new Set(["claude", "codex"]);
const FORK_SOURCE_UNAVAILABLE = "branch fork source session is not available";

export const GET = withAuth(async (_req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(_req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("conversation id is required", 400);

  const conversation = await queries.conversation.getConversation(
    db,
    id,
    ws.workspaceId,
  );
  if (!conversation) return writeError("conversation not found", 404);
  if (conversation.userId !== ctx.userId) {
    return writeError("conversation access denied", 403);
  }

  const branches = await queries.conversationBranch.listBranchesByParent(db, {
    workspaceId: ws.workspaceId,
    parentConversationId: id,
  });
  return writeJSON({ branches: branches.map(conversationBranchToResponse) });
});

export const POST = withAuth(async (req: NextRequest, ctx) => {
  const ws = await withWorkspaceMember(req, ctx);
  if (ws instanceof Response) return ws;

  const { env } = getCloudflareContext();
  const db = getDb((env as Env).DB);

  const id = ctx.params?.id;
  if (!id) return writeError("conversation id is required", 400);

  const [body, err] = await parseBody(req, CreateBranchRequestSchema);
  if (err) return err;

  const parentConversation = await queries.conversation.getConversation(
    db,
    id,
    ws.workspaceId,
  );
  if (!parentConversation) return writeError("conversation not found", 404);
  if (parentConversation.userId !== ctx.userId) {
    return writeError("conversation access denied", 403);
  }
  if (parentConversation.type !== CONVERSATION_TYPES.USER_DM_MESSAGE) {
    return writeError("only normal conversations can be branched", 400);
  }

  const rootMessage = await queries.message.getMessageForConversation(
    db,
    id,
    body.root_message_id,
  );
  if (
    !rootMessage ||
    rootMessage.status !== "active"
  ) {
    return writeError("root message not found", 404);
  }
  if (!queries.message.isBranchableMessageRoot(rootMessage)) {
    return writeError("root message cannot be branched", 400);
  }

  const existingBranch = await queries.conversationBranch.getBranchForRoot(db, {
    workspaceId: ws.workspaceId,
    parentConversationId: id,
    rootMessageId: body.root_message_id,
  });
  if (existingBranch) {
    const existingConversation = await queries.conversation.getConversation(
      db,
      existingBranch.branchConversationId,
      ws.workspaceId,
    );
    if (!existingConversation) {
      return writeError("branch conversation not found", 500);
    }
    return writeJSON({
      branch: conversationBranchToResponse(existingBranch),
      conversation: conversationToResponse(existingConversation),
    });
  }

  const agent = await queries.agent.getAgent(
    db,
    parentConversation.agentId,
    ws.workspaceId,
    ctx.userId,
  );
  if (!agent) return writeError("agent not found", 404);
  if (!agent.runtimeId) return writeError("agent has no runtime", 400);

  const forkSource = await queries.task.getLatestCompletedTaskWithSessionForConversation(
    db,
    { workspaceId: ws.workspaceId, conversationId: id },
  );
  if (!forkSource?.sessionId) {
    return writeError(FORK_SOURCE_UNAVAILABLE, 409);
  }
  const forkRuntime = await queries.runtime.getAgentRuntimeForWorkspace(
    db,
    forkSource.runtimeId,
    ws.workspaceId,
  );
  const forkProvider = forkRuntime?.provider ?? null;
  if (!forkProvider || !BRANCHABLE_PROVIDERS.has(forkProvider)) {
    return writeError("fork source runtime does not support message branching", 400);
  }

  const runtime = await queries.runtime.getAgentRuntimeForWorkspace(
    db,
    agent.runtimeId,
    ws.workspaceId,
  );
  const provider = runtime?.provider ?? null;
  if (!provider || !BRANCHABLE_PROVIDERS.has(provider)) {
    return writeError("agent runtime does not support message branching", 400);
  }
  if (provider !== forkProvider) {
    return writeError(
      "agent runtime provider does not match fork source provider",
      409,
    );
  }

  const branchConversation = await queries.conversation.createConversation(db, {
    workspaceId: ws.workspaceId,
    agentId: parentConversation.agentId,
    userId: ctx.userId,
    title: parentConversation.title,
    type: CONVERSATION_TYPES.MESSAGE_BRANCH,
    channel: parentConversation.channel,
  });

  const branch = await queries.conversationBranch.createBranch(db, {
    workspaceId: ws.workspaceId,
    parentConversationId: parentConversation.id,
    branchConversationId: branchConversation.id,
    rootMessageId: rootMessage.id,
    provider: forkProvider,
    forkSourceTaskId: forkSource.id,
    forkSourceSessionId: forkSource.sessionId,
    createdBy: ctx.userId,
  });

  return writeJSON(
    {
      branch: conversationBranchToResponse(branch),
      conversation: conversationToResponse(branchConversation),
    },
    201,
  );
});
