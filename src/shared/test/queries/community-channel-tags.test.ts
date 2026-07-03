import { describe, it, expect, vi, beforeEach } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../src/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  }),
}));

import * as channelQueries from "../../src/db/queries/community/channel";

function channelRow(id: string, forumTags: string | null) {
  return {
    id,
    serverId: "s_1",
    categoryId: null,
    name: `ch-${id}`,
    type: "forum",
    topic: "",
    position: 0,
    forumTags,
    parentChannelId: null,
    creatorId: null,
    messageCount: 0,
    archived: 0,
    parentMessageId: null,
    lastMessageAt: null,
    createdAt: "2025-01-01T00:00:00.000Z",
  };
}

// Chain mock that resolves either at `.where()` or after `.orderBy()`.
// listServerChannels ends in orderBy → make it a Promise-and-chain hybrid.
function createSelectMock(rows: any[]) {
  const chain: any = {};
  const terminal = () => Object.assign(Promise.resolve(rows), chain);
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.leftJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => terminal());
  chain.orderBy = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("safeParseForumTags via getChannel", () => {
  beforeEach(() => warn.mockReset());

  it("valid forumTags JSON → tags: string[]; no log", async () => {
    const db = createSelectMock([channelRow("ch_1", '["bug","q&a"]')]);
    const result = await channelQueries.getChannel(db, "ch_1");
    expect(result?.tags).toEqual(["bug", "q&a"]);
    expect(result).not.toHaveProperty("forumTags");
    expect(warn).not.toHaveBeenCalled();
  });

  it("malformed forumTags → tags: []; warn once with { channelId, err }", async () => {
    const db = createSelectMock([channelRow("ch_bad", "{bad")]);
    const result = await channelQueries.getChannel(db, "ch_bad");
    expect(result?.tags).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "forum_tags_parse_failed",
      expect.objectContaining({ channelId: "ch_bad", err: expect.any(Error) }),
    );
  });

  it("forumTags: null → tags: []; no log", async () => {
    const db = createSelectMock([channelRow("ch_null", null)]);
    const result = await channelQueries.getChannel(db, "ch_null");
    expect(result?.tags).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("forumTags parses to non-array → tags: []; warn forum_tags_not_array", async () => {
    const db = createSelectMock([channelRow("ch_obj", '{"foo":1}')]);
    const result = await channelQueries.getChannel(db, "ch_obj");
    expect(result?.tags).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "forum_tags_not_array",
      expect.objectContaining({ channelId: "ch_obj" }),
    );
  });

  it("no rows → null; no log", async () => {
    const db = createSelectMock([]);
    const result = await channelQueries.getChannel(db, "missing");
    expect(result).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("safeParseForumTags via listServerChannels", () => {
  beforeEach(() => warn.mockReset());

  it("maps each row's forumTags into tags: []-fallback + parsed", async () => {
    const rows = [
      channelRow("ch_1", '["a"]'),
      channelRow("ch_2", null),
      channelRow("ch_3", "{bad"),
    ];
    const db = createSelectMock(rows);
    const result = await channelQueries.listServerChannels(db, "s_1");
    expect(result[0]!.tags).toEqual(["a"]);
    expect(result[1]!.tags).toEqual([]);
    expect(result[2]!.tags).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "forum_tags_parse_failed",
      expect.objectContaining({ channelId: "ch_3" }),
    );
  });
});

describe("safeParseForumTags via listChildChannels", () => {
  beforeEach(() => warn.mockReset());

  it("returns rows with tags parsed", async () => {
    const db = createSelectMock([channelRow("ch_1", '["x","y"]')]);
    const result = await channelQueries.listChildChannels(db, "ch_parent");
    expect(result[0]!.tags).toEqual(["x", "y"]);
  });
});

describe("safeParseForumTags via getChannelsByIds", () => {
  beforeEach(() => warn.mockReset());

  it("empty ids short-circuits without hitting the db", async () => {
    const db = createSelectMock([channelRow("ch_1", null)]);
    const result = await channelQueries.getChannelsByIds(db, []);
    expect(result).toEqual([]);
    expect(db.select).not.toHaveBeenCalled();
  });

  it("maps forumTags → tags per row", async () => {
    const db = createSelectMock([
      channelRow("ch_1", '["a"]'),
      channelRow("ch_2", '["b","c"]'),
    ]);
    const result = await channelQueries.getChannelsByIds(db, ["ch_1", "ch_2"]);
    expect(result[0]!.tags).toEqual(["a"]);
    expect(result[1]!.tags).toEqual(["b", "c"]);
  });
});

describe("safeParseForumTags via getChannelForMember", () => {
  beforeEach(() => warn.mockReset());

  it("parses forumTags into tags", async () => {
    const row = channelRow("ch_1", '["bug"]');
    const db = createSelectMock([row]);
    const result = await channelQueries.getChannelForMember(db, "ch_1", "u_1");
    expect(result?.tags).toEqual(["bug"]);
  });
});
