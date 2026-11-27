import { describe, expect, it } from "vitest";
import { AlookPageOperationSchema, AlookPageCommentSchema, getAlookPageEmbeds } from "./community-page";

describe("Alook Page wire contract", () => {
  it("extracts valid cards while preserving unrelated embeds and refusing injected destinations", () => {
    const page = { kind: "alook_page", id: "page_1", type: "docs", title: "A document" };
    const unrelated = { kind: "decision_card", title: "An unrelated embed" };
    const input = [unrelated, page, { ...page, id: "bad/url" }, { ...page, embedUrl: "https://evil.example" }, null];
    expect(getAlookPageEmbeds(input)).toEqual([page]);
    expect(input[0]).toBe(unrelated);
    expect(getAlookPageEmbeds([page, page])).toEqual([page]);
    expect(getAlookPageEmbeds(undefined)).toEqual([]);
  });

  it("accepts positioned comments but never caller-selected identities or conversations", () => {
    expect(AlookPageCommentSchema.parse({ text: "  Fix this paragraph  ", location: "section=2" }))
      .toEqual({ text: "Fix this paragraph", location: "section=2" });
    for (const value of [
      { text: " " }, { text: "x".repeat(8001) }, { text: "hello", authorId: "owner" },
      { text: "hello", botId: "other" }, { text: "hello", channelId: "other" },
    ]) expect(AlookPageCommentSchema.safeParse(value).success).toBe(false);
  });
});

it("refuses unsafe paths and unconditional Page writes", () => {
  for (const path of ["/absolute", "../outside", "a/../b", "a\\b", "a//b"]) expect(AlookPageOperationSchema.safeParse({ kind: "read", path }).success).toBe(false);
  expect(AlookPageOperationSchema.safeParse({ kind: "write", writes: [{ path: "index.html", content: "YQ==" }] }).success).toBe(false);
  expect(AlookPageOperationSchema.safeParse({ kind: "write", writes: [{ path: "index.html", content: "YQ==", if_match: null }] }).success).toBe(true);
})

it("identifies bounded raster covers and rejects scriptable or spoofed formats", async () => {
 const { PAGE_COVER_MAX_BYTES, pageCoverContentType } = await import("./community-page");
 const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lqkAAAAASUVORK5CYII=", "base64");
 expect(pageCoverContentType(png)).toBe("image/png"); expect(pageCoverContentType(png.subarray(0, 24))).toBeNull();
 for (const source of ["<svg/>", "<html>hello</html>", "GIF89a"]) expect(pageCoverContentType(new TextEncoder().encode(source))).toBeNull();
 expect(pageCoverContentType(new Uint8Array(PAGE_COVER_MAX_BYTES + 1))).toBeNull();
});
