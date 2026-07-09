import { describe, it, expect, vi } from "vitest";
import { createThreadChannel } from "../../src/db/queries/community/channel";

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
});
