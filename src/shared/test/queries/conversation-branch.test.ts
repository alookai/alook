import { describe, it, expect, vi } from "vitest";
import * as branchQueries from "../../src/db/queries/conversation-branch";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  chain.innerJoin = vi.fn(() => chain);
  return chain;
}

describe("conversation branch query module exports", () => {
  it("exports createBranch", () => {
    expect(typeof branchQueries.createBranch).toBe("function");
  });

  it("exports listBranchesByParent", () => {
    expect(typeof branchQueries.listBranchesByParent).toBe("function");
  });

  it("exports getBranchForRoot", () => {
    expect(typeof branchQueries.getBranchForRoot).toBe("function");
  });

  it("exports getBranchByConversation", () => {
    expect(typeof branchQueries.getBranchByConversation).toBe("function");
  });

  it("exports getBranchOrigin", () => {
    expect(typeof branchQueries.getBranchOrigin).toBe("function");
  });
});

describe("conversation branch queries", () => {
  it("creates and returns a branch row", async () => {
    const branch = { id: "br_1", rootMessageId: "m1" };
    const mockDb = createMockDb([branch]);

    const result = await branchQueries.createBranch(mockDb, {
      workspaceId: "w1",
      parentConversationId: "parent_c",
      branchConversationId: "branch_c",
      rootMessageId: "m1",
      provider: "claude",
      forkSourceTaskId: "task_1",
      forkSourceSessionId: "session_1",
      createdBy: "u1",
    });

    expect(result).toEqual(branch);
    expect(mockDb.values).toHaveBeenCalledWith({
      workspaceId: "w1",
      parentConversationId: "parent_c",
      branchConversationId: "branch_c",
      rootMessageId: "m1",
      provider: "claude",
      forkSourceTaskId: "task_1",
      forkSourceSessionId: "session_1",
      createdBy: "u1",
    });
  });

  it("returns null when no root branch exists", async () => {
    const mockDb = createMockDb([]);

    const result = await branchQueries.getBranchForRoot(mockDb, {
      workspaceId: "w1",
      parentConversationId: "parent_c",
      rootMessageId: "m_missing",
    });

    expect(result).toBeNull();
  });

  it("returns null when no branch conversation mapping exists", async () => {
    const mockDb = createMockDb([]);

    const result = await branchQueries.getBranchByConversation(mockDb, {
      workspaceId: "w1",
      branchConversationId: "branch_missing",
    });

    expect(result).toBeNull();
  });

  it("loads branch origin with the root message join", async () => {
    const origin = {
      branch: { id: "br_1", rootMessageId: "m1" },
      rootMessage: { id: "m1", content: "last message" },
    };
    const mockDb = createMockDb([origin]);

    const result = await branchQueries.getBranchOrigin(mockDb, {
      workspaceId: "w1",
      branchConversationId: "branch_c",
    });

    expect(result).toEqual(origin);
    expect(mockDb.innerJoin).toHaveBeenCalled();
    expect(mockDb.limit).toHaveBeenCalledWith(1);
  });
});
