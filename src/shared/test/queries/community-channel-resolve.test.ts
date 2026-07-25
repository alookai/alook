import { describe, it, expect, vi } from "vitest";
import * as channelQueries from "../../src/db/queries/community/channel";

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

// Render a single Drizzle chunk to a stable token we can pattern-match.
// Column instances → `col:<name>`; StringChunk-like (`.value: string[]`) →
// their inline SQL fragment(s); bind Param instances (`.encoder` present)
// → `?`; anything else → `?` too. Bare-string `.value` chunks fall through
// to their raw value — used by StringChunk in some drizzle versions.
function renderChunk(c: unknown): string {
  if (typeof c === "string") return c;
  if (c && typeof c === "object") {
    const rec = c as Record<string, unknown>;
    if (rec.name && typeof rec.name === "string" && "table" in rec) return `col:${rec.name}`;
    if ("encoder" in rec) return "?";
    if (Array.isArray(rec.value)) {
      return rec.value.filter((v) => typeof v === "string").map((v) => (v as string).trim()).join(" ").trim();
    }
    if (typeof rec.value === "string") return (rec.value as string).trim();
  }
  return "?";
}

// Flatten a Drizzle `SQL(...)` node into an ordered list of rendered tokens.
// Each leaf keeps its position, so downstream assertions can match a
// contiguous phrase like `[col:X, "is null"]` rather than checking two
// unrelated substrings in one big string.
function flattenTokens(expr: unknown, out: string[] = []): string[] {
  if (expr == null || typeof expr !== "object") return out;
  const e = expr as Record<string, unknown>;
  if (Array.isArray(e.queryChunks)) {
    for (const chunk of e.queryChunks) flattenTokens(chunk, out);
    return out;
  }
  out.push(renderChunk(expr));
  return out;
}

// True iff the ordered token list contains a contiguous `[col:X, tail]`
// phrase — i.e. `is null` is applied to X specifically, not to some other
// column that happens to sit elsewhere in the predicate.
function tokensContainPhrase(tokens: string[], colName: string, tail: string): boolean {
  const wantCol = `col:${colName}`;
  const wantTail = tail.toLowerCase();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === wantCol && tokens[i + 1]!.toLowerCase().startsWith(wantTail)) return true;
  }
  return false;
}

describe("resolveChannelByNameForMember — SQL invariants", () => {
  it("filters by name AND parent_channel_id IS NULL (top-level only)", async () => {
    const db = createSelectChain([]);
    await channelQueries.resolveChannelByNameForMember(db as never, "srv_1", "u_1", "general");

    expect(db.where).toHaveBeenCalledOnce();
    const [whereExpr] = db.where.mock.calls[0]!;
    const tokens = flattenTokens(whereExpr);

    // The name predicate compares against the name column, not the id column.
    expect(tokens).toContain("col:name");
    expect(tokens).not.toContain("col:id");

    // `IS NULL` must be applied to `parent_channel_id` specifically — a
    // future refactor that swapped in `isNull(categoryId)` while still
    // referencing `parentChannelId` elsewhere in the predicate would not
    // reproduce the invariant. This is the whole point of the fix.
    expect(tokensContainPhrase(tokens, "parent_channel_id", "is null")).toBe(true);
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
    const tokens = flattenTokens(whereExpr);
    // The id column of communityChannel must NOT be part of the predicate —
    // that's the "no id back-door" guarantee the plan locks in.
    expect(tokens).not.toContain("col:id");
  });

  it("scopes lookup to server AND caller's membership (no cross-server leak)", async () => {
    const db = createSelectChain([]);
    await channelQueries.resolveChannelByNameForMember(db as never, "srv_1", "u_1", "general");

    // innerJoin is what enforces membership-scoping; dropping it would let a
    // caller resolve channels on servers they don't belong to.
    const chain = db as unknown as { innerJoin: ReturnType<typeof vi.fn> };
    expect(chain.innerJoin).toHaveBeenCalledOnce();

    const [whereExpr] = db.where.mock.calls[0]!;
    const tokens = flattenTokens(whereExpr);
    expect(tokens).toContain("col:server_id");
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
