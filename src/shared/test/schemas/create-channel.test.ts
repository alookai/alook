import { describe, it, expect } from "vitest";
import {
  CreateChannelRequestSchema,
  UpdateChannelRequestSchema,
} from "../../src/schemas";

// The human composer's attachment object shape (upload response), which the
// post arm validates — NOT id strings (that's the agent pre-mint path).
const ATTACHMENT = {
  url: "/api/community/media/k1",
  filename: "a.png",
  contentType: "image/png",
  size: 123,
};

describe("CreateChannelRequestSchema — discriminated union", () => {
  it("accepts a text channel with serverId + name", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "text",
      serverId: "srv_1",
      name: "general",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a forum channel", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "forum",
      serverId: "srv_1",
      name: "help",
    });
    expect(r.success).toBe(true);
  });

  it("rejects text missing name", () => {
    const r = CreateChannelRequestSchema.safeParse({ type: "text", serverId: "srv_1" });
    expect(r.success).toBe(false);
  });

  it("rejects post missing parentChannelId", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      name: "my post",
      content: "hi",
    });
    expect(r.success).toBe(false);
  });

  it("rejects thread missing parentMessageId", () => {
    const r = CreateChannelRequestSchema.safeParse({ type: "thread", name: "re: x" });
    expect(r.success).toBe(false);
  });

  it("rejects thread missing name", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "thread",
      parentMessageId: "m_1",
    });
    expect(r.success).toBe(false);
  });

  it("rejects an illegal type value", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "dm",
      serverId: "srv_1",
      name: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("CreateChannelRequestSchema — post arm (R9 content optional)", () => {
  it("accepts content-only post (no attachments)", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "the body",
    });
    expect(r.success).toBe(true);
  });

  it("accepts attachment-only post (empty content)", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "",
      attachments: [ATTACHMENT],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a post with neither content nor attachments (post is empty)", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "   ",
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.some((i) => i.message === "post is empty")).toBe(true);
    }
  });

  it("defaults content to empty string when omitted (attachments carry it)", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      attachments: [ATTACHMENT],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "post") {
      expect(r.data.content).toBe("");
    }
  });
});

describe("CreateChannelRequestSchema — post arm field names (R13/R14)", () => {
  it("uses `attachments`, not `attachmentIds`", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "hi",
      attachments: [ATTACHMENT, { ...ATTACHMENT, filename: "b.png" }],
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "post") {
      expect(r.data.attachments).toHaveLength(2);
      expect(r.data.attachments?.[0]?.url).toBe("/api/community/media/k1");
    }
  });

  it("rejects id-string attachments (agent pre-mint form) on the human post arm", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "hi",
      attachments: ["att_1"],
    });
    expect(r.success).toBe(false);
  });

  it("carries mentionType for roster broadcast", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "@everyone hi",
      mentionType: "everyone",
    });
    expect(r.success).toBe(true);
    if (r.success && r.data.type === "post") {
      expect(r.data.mentionType).toBe("everyone");
    }
  });

  it("rejects an invalid mentionType", () => {
    const r = CreateChannelRequestSchema.safeParse({
      type: "post",
      parentChannelId: "ch_forum",
      name: "title",
      content: "hi",
      mentionType: "channel",
    });
    expect(r.success).toBe(false);
  });
});

describe("UpdateChannelRequestSchema", () => {
  it("accepts a name-only edit", () => {
    const r = UpdateChannelRequestSchema.safeParse({ name: "renamed" });
    expect(r.success).toBe(true);
  });

  it("accepts forumTags array and null", () => {
    expect(UpdateChannelRequestSchema.safeParse({ forumTags: ["a", "b"] }).success).toBe(true);
    expect(UpdateChannelRequestSchema.safeParse({ forumTags: null }).success).toBe(true);
  });

  it("accepts nulling categoryId", () => {
    expect(UpdateChannelRequestSchema.safeParse({ categoryId: null }).success).toBe(true);
  });
});
