import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { readCommunityImageDimensions } from "./imageMetadata.js";

describe("original image metadata", () => {
  it("reports displayed JPEG dimensions after EXIF orientation without rewriting bytes", async () => {
    const bytes = await sharp({ create: { width: 40, height: 20, channels: 3, background: "white" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const original = Buffer.from(bytes);
    expect(await readCommunityImageDimensions(bytes, "image/jpeg")).toEqual({ width: 20, height: 40 });
    expect(bytes).toEqual(original);
  });
  it("leaves invalid data and non-inline formats without mandatory metadata", async () => {
    expect(await readCommunityImageDimensions(new Uint8Array([1, 2, 3]), "image/png")).toEqual({});
    expect(await readCommunityImageDimensions(new Uint8Array([1, 2, 3]), "image/svg+xml")).toEqual({});
  });
});
