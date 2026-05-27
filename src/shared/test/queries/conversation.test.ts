import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as conversationQueries from "../../src/db/queries/conversation";
import { TASK_TYPES } from "../../src/constants";

describe("conversation query module exports", () => {
  it("exports createConversation", () => {
    expect(typeof conversationQueries.createConversation).toBe("function");
  });

  it("exports getConversation", () => {
    expect(typeof conversationQueries.getConversation).toBe("function");
  });

  it("exports listConversations", () => {
    expect(typeof conversationQueries.listConversations).toBe("function");
  });

  it("exports listConversationsByAgent", () => {
    expect(typeof conversationQueries.listConversationsByAgent).toBe("function");
  });

  it("exports getOrCreateAgentConversation", () => {
    expect(typeof conversationQueries.getOrCreateAgentConversation).toBe("function");
  });

  it("exports deleteConversation", () => {
    expect(typeof conversationQueries.deleteConversation).toBe("function");
  });

  it("exports listPreviousConversations", () => {
    expect(typeof conversationQueries.listPreviousConversations).toBe("function");
  });
});

describe("conversation query function signatures (with optional channel param)", () => {
  it("listConversations accepts at least 3 params (db, workspaceId, userId) plus optional channel", () => {
    expect(conversationQueries.listConversations.length).toBeGreaterThanOrEqual(3);
  });

  it("listConversationsByAgent accepts at least 4 params plus optional channel", () => {
    expect(conversationQueries.listConversationsByAgent.length).toBeGreaterThanOrEqual(4);
  });

  it("getOrCreateAgentConversation accepts at least 4 params plus optional channel", () => {
    expect(conversationQueries.getOrCreateAgentConversation.length).toBeGreaterThanOrEqual(4);
  });

  it("listPreviousConversations accepts at least 5 params (db, workspaceId, userId, agentId, excludeId)", () => {
    expect(conversationQueries.listPreviousConversations.length).toBeGreaterThanOrEqual(5);
  });
});

describe("conversation list visibility", () => {
  it("marks email_triage as hidden conversation type", () => {
    expect(conversationQueries.CONVERSATION_LIST_EXCLUDED_TYPES).toContain(TASK_TYPES.EMAIL_TRIAGE);
  });

  it("list queries exclude email_triage at SQL level", () => {
    const src = readFileSync(join(__dirname, "../../src/db/queries/conversation.ts"), "utf8");
    expect(src).toContain("CONVERSATION_LIST_EXCLUDED_TYPES");
    expect(src).toContain("notInArray(conversation.type");
  });
});
