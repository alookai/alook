import { describe, it, expect } from "vitest";
import * as issueCommentQueries from "../../src/db/queries/issue-comment";

describe("issue-comment query module exports", () => {
  it("exports createComment", () => {
    expect(typeof issueCommentQueries.createComment).toBe("function");
  });

  it("exports listComments", () => {
    expect(typeof issueCommentQueries.listComments).toBe("function");
  });

  it("exports deleteComment", () => {
    expect(typeof issueCommentQueries.deleteComment).toBe("function");
  });

  it("exports commentToResponse", () => {
    expect(typeof issueCommentQueries.commentToResponse).toBe("function");
  });
});

describe("commentToResponse", () => {
  it("maps DB row to API response shape with snake_case keys", () => {
    const row = {
      id: "ic_001",
      issueId: "iss_123",
      workspaceId: "ws_456",
      authorType: "agent",
      authorId: "ag_789",
      content: "This looks good!",
      createdAt: "2026-03-10T14:30:00.000Z",
    };

    const result = issueCommentQueries.commentToResponse(row as any);

    expect(result).toEqual({
      id: "ic_001",
      issue_id: "iss_123",
      workspace_id: "ws_456",
      author_type: "agent",
      author_id: "ag_789",
      content: "This looks good!",
      created_at: "2026-03-10T14:30:00.000Z",
    });
  });

  it("preserves user author type", () => {
    const row = {
      id: "ic_002",
      issueId: "iss_100",
      workspaceId: "ws_1",
      authorType: "user",
      authorId: "usr_1",
      content: "Fixed in latest commit",
      createdAt: "2026-04-01T09:00:00.000Z",
    };

    const result = issueCommentQueries.commentToResponse(row as any);
    expect(result.author_type).toBe("user");
  });
});
