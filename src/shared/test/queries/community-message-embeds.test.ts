import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock is hoisted above the top of the module — plain `const` bindings
// aren't. vi.hoisted lets the spy live in the mocked module's closure
// without hitting the temporal-dead-zone.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  }),
}));

import * as messageQueries from "../../src/db/queries/community/message";

function messageRow(id: string, embeds: string | null) {
  return {
    id,
    authorId: `u_${id}`,
    content: `hi from ${id}`,
    type: "default",
    mentionType: null,
    replyToId: null,
    embeds,
    flags: 0,
    createdAt: "2025-01-01T00:00:00.000Z",
    channelId: "ch_1",
    dmConversationId: null,
    authorName: `User ${id}`,
    authorEmail: `${id}@x.com`,
    authorImage: null,
  };
}

// Chain mock that resolves either at `.where()` (getMessage/getMessagesByIds)
// or at `.limit()` (listMessages). Same shape as the existing
// community-message.test.ts helper.
function createSelectMock(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.orderBy = vi.fn(() => chain);
  chain.where = vi.fn(() => {
    // where() is terminal for getMessage/getMessagesByIds. For listMessages
    // the chain continues into .limit(), which we also short-circuit below.
    return Object.assign(Promise.resolve(rows), chain);
  });
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("safeParseEmbeds via listMessages", () => {
  beforeEach(() => warn.mockReset());

  it("valid embeds JSON is parsed and no warn is logged", async () => {
    const raw = '[{"url":"https://x/y","title":"t"}]';
    const db = createSelectMock([messageRow("m_1", raw)]);
    const result = await messageQueries.listMessages(db, { channelId: "ch_1" });
    expect(result[0]!.embeds).toEqual([{ url: "https://x/y", title: "t" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("malformed embeds returns undefined and warns once with { messageId, err }", async () => {
    const db = createSelectMock([messageRow("m_bad", "{not json")]);
    const result = await messageQueries.listMessages(db, { channelId: "ch_1" });
    expect(result[0]!.embeds).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "embeds_parse_failed",
      expect.objectContaining({ messageId: "m_bad", err: expect.any(Error) }),
    );
  });

  it("embeds: null yields undefined without a log", async () => {
    const db = createSelectMock([messageRow("m_null", null)]);
    const result = await messageQueries.listMessages(db, { channelId: "ch_1" });
    expect(result[0]!.embeds).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("embeds: empty string yields undefined without a log", async () => {
    const db = createSelectMock([messageRow("m_empty", "")]);
    const result = await messageQueries.listMessages(db, { channelId: "ch_1" });
    expect(result[0]!.embeds).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("mixed corruption: 5 rows, only row 3 malformed", async () => {
    const rows = [
      messageRow("m_1", '[{"url":"a"}]'),
      messageRow("m_2", null),
      messageRow("m_3", "{bad"),
      messageRow("m_4", ""),
      messageRow("m_5", '[{"url":"e"}]'),
    ];
    const db = createSelectMock(rows);
    const result = await messageQueries.listMessages(db, { channelId: "ch_1" });
    expect(result).toHaveLength(5);
    expect(result[0]!.embeds).toEqual([{ url: "a" }]);
    expect(result[1]!.embeds).toBeUndefined();
    expect(result[2]!.embeds).toBeUndefined();
    expect(result[3]!.embeds).toBeUndefined();
    expect(result[4]!.embeds).toEqual([{ url: "e" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "embeds_parse_failed",
      expect.objectContaining({ messageId: "m_3" }),
    );
  });
});

describe("safeParseEmbeds via getMessage", () => {
  beforeEach(() => warn.mockReset());

  it("valid embeds → parsed; no log", async () => {
    const db = createSelectMock([messageRow("m_1", '[{"url":"z"}]')]);
    const result = await messageQueries.getMessage(db, "m_1");
    expect(result?.embeds).toEqual([{ url: "z" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("malformed embeds → undefined; warn once", async () => {
    const db = createSelectMock([messageRow("m_bad", "{bad")]);
    const result = await messageQueries.getMessage(db, "m_bad");
    expect(result?.embeds).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("no rows → null; no log", async () => {
    const db = createSelectMock([]);
    const result = await messageQueries.getMessage(db, "m_missing");
    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("safeParseEmbeds via getMessagesByIds", () => {
  beforeEach(() => warn.mockReset());

  it("parses embeds across the batch", async () => {
    const db = createSelectMock([
      messageRow("m_1", '[{"url":"a"}]'),
      messageRow("m_2", null),
    ]);
    const result = await messageQueries.getMessagesByIds(db, ["m_1", "m_2"]);
    expect(result[0]!.embeds).toEqual([{ url: "a" }]);
    expect(result[1]!.embeds).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("empty ids short-circuits without hitting the db", async () => {
    const db = createSelectMock([messageRow("m_1", null)]);
    const result = await messageQueries.getMessagesByIds(db, []);
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });
});
