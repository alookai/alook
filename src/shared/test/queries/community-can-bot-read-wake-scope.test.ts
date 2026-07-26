import { describe, it, expect, vi, beforeEach } from "vitest";

const mockResolveChannelAccessContext = vi.fn();
vi.mock("../../src/db/queries/community/channel", () => ({
  resolveChannelAccessContext: (...a: unknown[]) => mockResolveChannelAccessContext(...a),
}));

const mockIsThreadParticipant = vi.fn();
vi.mock("../../src/db/queries/community/thread", () => ({
  isThreadParticipant: (...a: unknown[]) => mockIsThreadParticipant(...a),
}));

import { canBotReadWakeScope } from "../../src/db/queries/community/member";
import type { Database } from "../../src/db/index";

// The DM branch runs a real Drizzle query — build the smallest chainable stub
// that resolves to whatever `rows` we hand it, so DM cases don't need a real
// DB either.
function createDmDb(rows: unknown[]): Database {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => chain);
  chain.limit = vi.fn(() => Promise.resolve(rows));
  return chain as Database;
}

const fakeDb = {} as Database;

// The `channel` object the real `resolveChannelAccessContext` returns is a
// full ChannelRow; here we only need the `type` field, so a minimal stub is
// enough for the gate to branch correctly.
function ctx(overrides: {
  type: string;
  isPrivate?: boolean;
  role?: string;
  isCreator?: boolean;
  isChannelMember?: boolean;
}) {
  return {
    channel: { type: overrides.type },
    anchor: {},
    role: overrides.role ?? "member",
    isPrivate: overrides.isPrivate ?? false,
    isChannelMember: overrides.isChannelMember ?? false,
    isCreator: overrides.isCreator ?? false,
  };
}

describe("canBotReadWakeScope — visibility gate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("public top-level channel + bot IS a server member → true", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(ctx({ type: "text", isPrivate: false }));
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "ch_public" })).toBe(true);
  });

  it("public top-level channel + bot NOT a server member (ctx null) → false", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(null);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "ch_public" })).toBe(false);
  });

  it("private channel + bot IS on the roster → true", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      ctx({ type: "text", isPrivate: true, isChannelMember: true }),
    );
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "ch_secret" })).toBe(true);
  });

  it("private channel + bot NOT on the roster → false", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      ctx({ type: "text", isPrivate: true, isChannelMember: false }),
    );
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "ch_secret" })).toBe(false);
  });
});

describe("canBotReadWakeScope — notification-set narrowing (thread + post)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("public post + bot IS a thread participant → true", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(ctx({ type: "post", isPrivate: false }));
    mockIsThreadParticipant.mockResolvedValue(true);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "post_1" })).toBe(true);
  });

  it("public post + bot NOT a participant → false (regression guard for Mellicent's exact case)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(ctx({ type: "post", isPrivate: false }));
    mockIsThreadParticipant.mockResolvedValue(false);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "post_1" })).toBe(false);
  });

  it("thread under public channel + bot NOT a participant → false", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(ctx({ type: "thread", isPrivate: false }));
    mockIsThreadParticipant.mockResolvedValue(false);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "thread_1" })).toBe(false);
  });

  it("thread + bot IS a participant → true", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(ctx({ type: "thread", isPrivate: false }));
    mockIsThreadParticipant.mockResolvedValue(true);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "thread_1" })).toBe(true);
  });

  it("private post + bot on roster + IS a participant → true", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      ctx({ type: "post", isPrivate: true, isChannelMember: true }),
    );
    mockIsThreadParticipant.mockResolvedValue(true);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "post_priv" })).toBe(true);
  });

  it("private post + bot on roster but NOT a participant → false (both gates enforced)", async () => {
    mockResolveChannelAccessContext.mockResolvedValue(
      ctx({ type: "post", isPrivate: true, isChannelMember: true }),
    );
    mockIsThreadParticipant.mockResolvedValue(false);
    expect(await canBotReadWakeScope(fakeDb, "bot", { channelId: "post_priv" })).toBe(false);
  });
});

describe("canBotReadWakeScope — DM scope", () => {
  it("DM + bot is a participant → true", async () => {
    const db = createDmDb([{ id: "dm_1" }]);
    expect(await canBotReadWakeScope(db, "bot", { dmConversationId: "dm_1" })).toBe(true);
  });

  it("DM + bot is NOT a participant → false", async () => {
    const db = createDmDb([]);
    expect(await canBotReadWakeScope(db, "bot", { dmConversationId: "dm_1" })).toBe(false);
  });

  it("no scope provided → false", async () => {
    expect(await canBotReadWakeScope(fakeDb, "bot", {})).toBe(false);
  });
});
