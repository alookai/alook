import { describe, expect, it } from "vitest";
import { buildCommunityNotificationCopy } from "../../src/utils/community-notification-copy";

const base = {
  authorName: " Alice ",
  content: "**Hello** [there](https://example.test)\nnext line",
  attachments: [],
};

describe("buildCommunityNotificationCopy", () => {
  it("uses sender plus preview for a DM", () => {
    expect(buildCommunityNotificationCopy({
      ...base,
      conversationKind: "dm",
    })).toEqual({
      title: "Alice",
      body: "Hello there next line",
    });
  });

  it.each([
    [
      "channel",
      {
        ...base,
        conversationKind: "channel" as const,
        serverName: "Studio",
        channelName: "general",
      },
      { title: "Studio · #general", body: "Alice: Hello there next line" },
    ],
    [
      "thread",
      {
        ...base,
        conversationKind: "thread" as const,
        serverName: "Studio",
        parentChannelName: "announcements",
        channelName: "Release notes",
      },
      {
        title: "Studio · #announcements · Release notes",
        body: "Alice: Hello there next line",
      },
    ],
  ])("uses conversation context for a %s", (_label, input, expected) => {
    expect(buildCommunityNotificationCopy(input)).toEqual(expected);
  });

  it("uses one fallback policy for missing names and attachments", () => {
    expect(buildCommunityNotificationCopy({
      conversationKind: "thread",
      authorName: " ",
      content: " ",
      attachments: [{ name: "notes.pdf", contentType: "application/pdf" }, { name: "photo.png", contentType: "IMAGE/PNG" }],
      serverName: null,
      channelName: null,
      parentChannelName: null,
    })).toEqual({
      title: "Server · #Channel · Thread",
      body: "Alook: Attachment: notes.pdf Photo: photo.png",
    });
  });

  it.each([
    [["video/mp4"], "Video"],
    [["audio/mpeg"], "Audio"],
    [["application/pdf"], "Attachment"],
    [[], "New message"],
  ] as const)("uses the shared attachment fallback for %j", (attachmentContentTypes, expected) => {
    expect(buildCommunityNotificationCopy({
      ...base,
      conversationKind: "dm",
      content: "",
      attachments: attachmentContentTypes.map(contentType => ({ name: "", contentType })),
    })).toEqual({
      title: "Alice",
      body: expected,
    });
  });

  it("caps the complete author-prefixed body without splitting surrogate pairs", () => {
    const copy = buildCommunityNotificationCopy({
      ...base,
      conversationKind: "channel",
      serverName: "Studio",
      channelName: "general",
      content: `${"x".repeat(118)}😀tail`,
    });
    expect(copy.body.startsWith("Alice: ")).toBe(true);
    expect(copy.body.length).toBeLessThanOrEqual(120);
    expect(copy.body).not.toContain("�");
    expect(copy.body.endsWith("…")).toBe(true);
  });
});
