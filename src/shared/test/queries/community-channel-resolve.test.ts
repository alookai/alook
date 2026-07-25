import { describe, it, expect, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import * as channelQueries from "../../src/db/queries/community/channel";
import { communityChannel } from "../../src/db/community-schema";

// Captures the SQL expression handed to `.where()` so we can prove the
// resolver's invariants without a live D1 instance. The Drizzle query
// builder is fluent — `.select(...).from(...).innerJoin(...).where(expr)` —
// and each stage returns the same chain object; `where` resolves with the
// stubbed rows.
function createSelectChain(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn((_expr: unknown) => Promise.resolve(rows));
  return chain as unknown as { where: ReturnType<typeof vi.fn> };
}

// Flatten a Drizzle `SQL` chunk tree into the leaf tokens/columns we care
// about — enough to assert "this predicate references column X and uses IS
// NULL semantics" without duplicating the compiler.
function collectChunks(expr: unknown, out: unknown[] = []): unknown[] {
  if (expr == null || typeof expr !== "object") return out;
  const e = expr as Record<string, unknown>;
  if (Array.isArray(e.queryChunks)) {
    for (const chunk of e.queryChunks) collectChunks(chunk, out);
  } else if (Array.isArray(e.chunks)) {
    for (const chunk of e.chunks) collectChunks(chunk, out);
  } else {
    out.push(expr);
  }
  return out;
}

function chunksToString(chunks: unknown[]): string {
  return chunks
    .map((c) => {
      if (typeof c === "string") return c;
      if (c && typeof c === "object") {
        const rec = c as Record<string, unknown>;
        // Column reference (Drizzle Column instance).
        if (rec.name && typeof rec.name === "string" && "table" in rec) return `col:${rec.name}`;
        // Raw string chunk (StringChunk-like — `.value` is the SQL fragment).
        if (Array.isArray(rec.value)) return rec.value.filter((v) => typeof v === "string").join(" ");
        if (typeof rec.value === "string") return rec.value;
      }
      return "?";
    })
    .join(" ")
    .toLowerCase();
}

describe("resolveChannelByNameForMember — SQL invariants", () => {
  it("filters by name AND parent_channel_id IS NULL (top-level only)", async () => {
    const db = createSelectChain([]);
    await channelQueries.resolveChannelByNameForMember(db as never, "srv_1", "u_1", "general");

    expect(db.where).toHaveBeenCalledOnce();
    const [whereExpr] = db.where.mock.calls[0]!;
    const chunkStr = chunksToString(collectChunks(whereExpr));

    // The name predicate compares against the name column, not the id column.
    expect(chunkStr).toContain("col:name");
    expect(chunkStr).not.toMatch(/col:id\b/);

    // The parent_channel_id IS NULL predicate must be present — this is the
    // whole invariant of the fix. Without it, threads/forum_posts would leak
    // into name lookups and reintroduce the ambiguous-channel bug.
    expect(chunkStr).toContain("col:parent_channel_id");
    expect(chunkStr).toContain("is null");
  });

  it("does NOT fall back to matching by id (agent surfaces reject raw ids)", async () => {
    const db = createSelectChain([]);
    await channelQueries.resolveChannelByNameForMember(
      db as never,
      "srv_1",
      "u_1",
      "mFUplbfFL7PIzeiaP3Ysg",
    );

    // Exactly one SELECT — the deleted id-fallback would have made a second
    // roundtrip if the first missed. `.where` fires once per SELECT.
    expect(db.where).toHaveBeenCalledOnce();

    const [whereExpr] = db.where.mock.calls[0]!;
    const chunkStr = chunksToString(collectChunks(whereExpr));
    // The id column of communityChannel must NOT be part of the predicate —
    // that's the "no id back-door" guarantee the plan locks in.
    const idCol = getTableColumns(communityChannel).id;
    expect(idCol.name).toBe("id");
    expect(chunkStr).not.toContain("col:id");
  });

  it("scopes lookup to server AND caller's membership (no cross-server leak)", async () => {
    const db = createSelectChain([]);
    await channelQueries.resolveChannelByNameForMember(db as never, "srv_1", "u_1", "general");

    // innerJoin is what enforces membership-scoping; dropping it would let a
    // caller resolve channels on servers they don't belong to.
    const chain = db as unknown as { innerJoin: ReturnType<typeof vi.fn> };
    expect(chain.innerJoin).toHaveBeenCalledOnce();

    const [whereExpr] = db.where.mock.calls[0]!;
    const chunkStr = chunksToString(collectChunks(whereExpr));
    expect(chunkStr).toContain("col:server_id");
  });

  it("returns [] when no top-level row matches — the DB partial-unique guarantees ≤1", async () => {
    const db = createSelectChain([]);
    const rows = await channelQueries.resolveChannelByNameForMember(
      db as never,
      "srv_1",
      "u_1",
      "general",
    );
    expect(rows).toEqual([]);
  });

  it("returns the single matched row", async () => {
    const dbRow = {
      id: "ch_top",
      serverId: "srv_1",
      categoryId: null,
      name: "general",
      type: "text",
      topic: "",
      position: 0,
      forumTags: null,
      parentChannelId: null,
      creatorId: "u_1",
      messageCount: 0,
      archived: 0,
      parentMessageId: null,
      lastMessageAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const db = createSelectChain([dbRow]);
    const rows = await channelQueries.resolveChannelByNameForMember(
      db as never,
      "srv_1",
      "u_1",
      "general",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("ch_top");
    expect(rows[0]!.parentChannelId).toBeNull();
    // forumTags is projected as `tags: string[]` (safeParseForumTags).
    expect(rows[0]!.tags).toEqual([]);
  });
});
