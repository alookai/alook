import { describe, it, expect, vi } from "vitest";
import {
  createThreadChannel,
  getChildChannelByName,
  dedupeChildChannelSlug,
} from "../../src/db/queries/community/channel";

// Walk a Drizzle SQL node for a literal `COLLATE NOCASE` fragment (emitted by
// the `sql\`... COLLATE NOCASE = ...\`` templates). StringChunk literals live in
// `.value` (string or string[]); operator nodes hold children in `.queryChunks`.
function hasCollateNocase(expr: unknown): boolean {
  if (expr == null || typeof expr !== "object") return false;
  const e = expr as Record<string, unknown>;
  const val = e.value;
  if (typeof val === "string" && /collate\s+nocase/i.test(val)) return true;
  if (Array.isArray(val) && val.some((v) => typeof v === "string" && /collate\s+nocase/i.test(v))) return true;
  if (Array.isArray(e.queryChunks)) return e.queryChunks.some((c) => hasCollateNocase(c));
  return false;
}

// A thenable-chain db. `getChildChannelByName` issues one `db.select(...)`;
// `dedupeChildChannelSlug` now issues one select PER candidate (base slug, then
// `-2`, `-3`, …) so pass an array of per-call responses (FIFO). A bare
// `rows`-array is treated as the single response for the one-select callers.
// `.limit(1)` is supported for the dedup existence probe.
function createSelectDb(responses: unknown[] | unknown[][]) {
  const perCall: unknown[][] = Array.isArray(responses[0]) || responses.length === 0
    ? (responses as unknown[][])
    : [responses as unknown[]];
  let call = 0;
  const methods = ["from", "where", "limit"];
  const select = vi.fn(() => {
    const idx = call++;
    const chain: any = {};
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.then = (resolve: any, reject: any) =>
      Promise.resolve(perCall[idx] ?? []).then(resolve, reject);
    return chain;
  });
  return { select } as any;
}

/**
 * `createThreadChannel` mixes two `db.select()` round trips (parent-channel
 * lookup, parent-message lookup, run via `Promise.all`) with one `db.insert()`
 * and a final `db.select()` re-fetch (via `getChannel`). The thenable-chain
 * trick from `community-agent-inbox.test.ts` covers the selects (FIFO by
 * call order); `insert` is mocked separately since its shape
 * (`.values().returning()`) never varies here.
 */
function createMockDb(opts: {
  selectResponses: unknown[][];
  insertedId: string;
}) {
  let call = 0;
  const methods = ["from", "where"];
  const select = vi.fn(() => {
    const idx = call++;
    const chain: any = {};
    for (const m of methods) chain[m] = vi.fn(() => chain);
    chain.then = (resolve: any, reject: any) =>
      Promise.resolve(opts.selectResponses[idx] ?? []).then(resolve, reject);
    return chain;
  });
  const insertValues = vi.fn();
  const insert = vi.fn(() => ({
    values: vi.fn((v: any) => {
      insertValues(v);
      return { returning: vi.fn(() => Promise.resolve([{ id: opts.insertedId }])) };
    }),
  }));
  return { select, insert, __insertValues: insertValues } as any;
}

describe("createThreadChannel", () => {
  it("derives the thread name from the parent message's first 40 chars, trimmed", async () => {
    const longContent = "  " + "x".repeat(60) + "  ";
    const db = createMockDb({
      selectResponses: [
        [{ serverId: "srv_1" }], // parent channel lookup
        [{ content: longContent }], // parent message lookup
        [{ id: "thread_1", serverId: "srv_1", name: "x".repeat(40), type: "thread", forumTags: null }], // getChannel re-fetch
      ],
      insertedId: "thread_1",
    });
    await createThreadChannel(db, "ch_parent", "m_root", "u_1");
    expect(db.__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x".repeat(40), type: "thread" })
    );
  });

  it("falls back to the literal 'Thread' when the parent message has no usable text", async () => {
    const db = createMockDb({
      selectResponses: [
        [{ serverId: "srv_1" }],
        [{ content: "   " }], // whitespace-only → trims to empty
        [{ id: "thread_1", serverId: "srv_1", name: "Thread", type: "thread", forumTags: null }],
      ],
      insertedId: "thread_1",
    });
    await createThreadChannel(db, "ch_parent", "m_root", "u_1");
    expect(db.__insertValues).toHaveBeenCalledWith(expect.objectContaining({ name: "Thread" }));
  });

  it("always sets type: 'thread' — never inherits the parent's own type", async () => {
    const db = createMockDb({
      selectResponses: [
        [{ serverId: "srv_1" }],
        [{ content: "hello" }],
        [{ id: "thread_1", serverId: "srv_1", name: "hello", type: "thread", forumTags: null }],
      ],
      insertedId: "thread_1",
    });
    await createThreadChannel(db, "ch_parent", "m_root", "u_1");
    expect(db.__insertValues).toHaveBeenCalledWith(expect.objectContaining({ type: "thread" }));
  });

  it("sets parentChannelId/parentMessageId/creatorId on the insert, and returns the re-fetched channel", async () => {
    const db = createMockDb({
      selectResponses: [
        [{ serverId: "srv_1" }],
        [{ content: "hello" }],
        [{ id: "thread_1", serverId: "srv_1", name: "hello", type: "thread", forumTags: null }],
      ],
      insertedId: "thread_1",
    });
    const created = await createThreadChannel(db, "ch_parent", "m_root", "u_creator");
    expect(db.__insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        parentChannelId: "ch_parent",
        parentMessageId: "m_root",
        creatorId: "u_creator",
        serverId: "srv_1",
      })
    );
    expect(created).toMatchObject({ id: "thread_1", serverId: "srv_1" });
  });

  it("throws if the parent channel can't be found (defensive — resolver should never call it this way)", async () => {
    const db = createMockDb({ selectResponses: [[], [{ content: "hi" }]], insertedId: "x" });
    await expect(createThreadChannel(db, "ch_missing", "m_root", "u_1")).rejects.toThrow(/not found/);
  });

  it("throws when the parent is itself a child channel (forum post / thread) — no grandchild threads, closes the private-forum leak", async () => {
    const db = createMockDb({
      // parent-channel lookup returns a row whose own parentChannelId is set →
      // it's a forum_post/thread, not a top-level channel.
      selectResponses: [[{ serverId: "srv_1", parentChannelId: "forum_1" }], [{ content: "hi" }]],
      insertedId: "x",
    });
    await expect(createThreadChannel(db, "forum_post_1", "m_root", "u_1")).rejects.toThrow(/child channel/);
    expect(db.__insertValues).not.toHaveBeenCalled();
  });
});

describe("getChildChannelByName", () => {
  it("returns all matches (mapped rows) so the caller can detect ambiguity", async () => {
    const db = createSelectDb([
      { id: "post_1", name: "dupe", type: "forum_post", serverId: "srv_1", parentChannelId: "forum_1", forumTags: null },
      { id: "post_2", name: "dupe", type: "forum_post", serverId: "srv_1", parentChannelId: "forum_1", forumTags: null },
    ]);
    const rows = await getChildChannelByName(db, "forum_1", "dupe");
    expect(rows.map((r) => r.id)).toEqual(["post_1", "post_2"]);
  });

  it("returns [] when no post with that name exists under the forum", async () => {
    const db = createSelectDb([]);
    const rows = await getChildChannelByName(db, "forum_1", "ghost");
    expect(rows).toEqual([]);
  });

  it("matches the post name with COLLATE NOCASE — same ruler as top-level resolve (ref/id §4)", async () => {
    const db = createSelectDb([]);
    await getChildChannelByName(db, "forum_1", "notes");
    const chain = db.select.mock.results[0]!.value;
    const [whereExpr] = chain.where.mock.calls[0]!;
    expect(hasCollateNocase(whereExpr)).toBe(true);
  });
});

describe("dedupeChildChannelSlug", () => {
  // Each candidate is now probed with its OWN `COLLATE NOCASE` existence query
  // (SQL ruler, not a JS Set) — so responses are FIFO per candidate: a
  // non-empty response means "taken", `[]` means "free".
  it("returns the base slug unchanged when the first NOCASE probe finds nothing", async () => {
    const db = createSelectDb([[]]); // base slug free
    expect(await dedupeChildChannelSlug(db, "forum_1", "ideas")).toBe("ideas");
    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it("appends -2 on the first collision", async () => {
    const db = createSelectDb([[{ id: "p1" }], []]); // base taken, -2 free
    expect(await dedupeChildChannelSlug(db, "forum_1", "ideas")).toBe("ideas-2");
  });

  it("skips already-taken numbered suffixes (ideas, ideas-2 → ideas-3)", async () => {
    const db = createSelectDb([[{ id: "p1" }], [{ id: "p2" }], []]); // base, -2 taken; -3 free
    expect(await dedupeChildChannelSlug(db, "forum_1", "ideas")).toBe("ideas-3");
  });

  it("probes with COLLATE NOCASE — same SQLite ruler as resolve + the index (no JS fold)", async () => {
    const db = createSelectDb([[]]);
    await dedupeChildChannelSlug(db, "forum_1", "ideas");
    // The existence probe's where-expr carries a COLLATE NOCASE fragment: a
    // case-only variant (`Ideas`) counts as taken, matching the index/resolve.
    const chain = db.select.mock.results[0]!.value;
    const [whereExpr] = chain.where.mock.calls[0]!;
    expect(hasCollateNocase(whereExpr)).toBe(true);
  });
});
