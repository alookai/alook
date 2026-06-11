import { describe, it, expect, vi } from "vitest";
import * as artifactQueries from "../../src/db/queries/artifact";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  chain.insert = vi.fn(() => chain);
  chain.values = vi.fn(() => chain);
  chain.returning = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("artifact query module exports", () => {
  it("exports createArtifact", () => {
    expect(typeof artifactQueries.createArtifact).toBe("function");
  });

  it("exports listArtifactsByConversation", () => {
    expect(typeof artifactQueries.listArtifactsByConversation).toBe("function");
  });

  it("exports getArtifact", () => {
    expect(typeof artifactQueries.getArtifact).toBe("function");
  });

  it("exports artifactToResponse", () => {
    expect(typeof artifactQueries.artifactToResponse).toBe("function");
  });
});

describe("artifactToResponse", () => {
  it("maps DB row to API response shape", () => {
    const row = {
      id: "art_123",
      conversationId: "conv_456",
      agentId: "ag_789",
      workspaceId: "ws_001",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 2048,
      r2Key: "uploads/report.pdf",
      thumbnailR2Key: null,
      source: "upload",
      createdAt: "2026-01-15T10:00:00.000Z",
    };

    const result = artifactQueries.artifactToResponse(row as any);

    expect(result).toEqual({
      id: "art_123",
      conversation_id: "conv_456",
      agent_id: "ag_789",
      filename: "report.pdf",
      content_type: "application/pdf",
      size: 2048,
      source: "upload",
      has_thumbnail: false,
      created_at: "2026-01-15T10:00:00.000Z",
    });
  });

  it("returns has_thumbnail true when thumbnailR2Key is set", () => {
    const row = {
      id: "art_123",
      conversationId: "conv_456",
      agentId: "ag_789",
      workspaceId: "ws_001",
      filename: "photo.png",
      contentType: "image/png",
      size: 50000,
      r2Key: "uploads/photo.png",
      thumbnailR2Key: "uploads/photo_thumb.jpg",
      source: "agent",
      createdAt: "2026-01-15T10:00:00.000Z",
    };

    const result = artifactQueries.artifactToResponse(row as any);
    expect(result.has_thumbnail).toBe(true);
  });

  it("excludes internal fields like r2Key and workspaceId", () => {
    const row = {
      id: "art_1",
      conversationId: "conv_1",
      agentId: "ag_1",
      workspaceId: "ws_1",
      filename: "file.txt",
      contentType: "text/plain",
      size: 100,
      r2Key: "secret/key",
      thumbnailR2Key: null,
      source: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const result = artifactQueries.artifactToResponse(row as any);

    expect(result).not.toHaveProperty("r2Key");
    expect(result).not.toHaveProperty("workspace_id");
    expect(result).not.toHaveProperty("workspaceId");
    expect(result).not.toHaveProperty("thumbnailR2Key");
  });

  it("handles null source", () => {
    const row = {
      id: "art_1",
      conversationId: "conv_1",
      agentId: "ag_1",
      workspaceId: "ws_1",
      filename: "file.txt",
      contentType: "text/plain",
      size: 0,
      r2Key: "key",
      thumbnailR2Key: null,
      source: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };

    const result = artifactQueries.artifactToResponse(row as any);
    expect(result.source).toBeNull();
  });
});

describe("getArtifact", () => {
  it("returns null when no artifact found", async () => {
    const mockDb = createMockDb([]);
    mockDb.limit = vi.fn(() => Promise.resolve([]));
    mockDb.where = vi.fn(() => Promise.resolve([]));
    const result = await artifactQueries.getArtifact(mockDb, "art_missing", "ws_1");
    expect(result).toBeNull();
  });
});
