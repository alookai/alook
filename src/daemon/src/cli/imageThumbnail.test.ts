import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareCommunityImageUpload } from "./imageThumbnail";

const mockSharp = vi.hoisted(() => vi.fn());

vi.mock("sharp", () => ({ default: mockSharp }));

describe("prepareCommunityImageUpload", () => {
  beforeEach(() => mockSharp.mockReset());

  it("handles missing decoded dimensions according to the byte-size requirement", async () => {
    mockSharp.mockReturnValue({
      metadata: vi.fn().mockResolvedValue({ width: undefined, height: 480 }),
    });

    await expect(
      prepareCommunityImageUpload(new Uint8Array(1), "image/png"),
    ).resolves.toEqual({});
    await expect(
      prepareCommunityImageUpload(new Uint8Array(512 * 1024 + 1), "image/png"),
    ).rejects.toThrow("required image preview");
  });

  it("rejects when every bounded JPEG candidate remains over the byte cap", async () => {
    const pipeline = {
      metadata: vi.fn().mockResolvedValue({ width: 1025, height: 512 }),
      resize: vi.fn(),
      jpeg: vi.fn(),
      toBuffer: vi.fn().mockResolvedValue(new Uint8Array(512 * 1024 + 1)),
    };
    pipeline.resize.mockReturnValue(pipeline);
    pipeline.jpeg.mockReturnValue(pipeline);
    mockSharp.mockReturnValue(pipeline);

    await expect(
      prepareCommunityImageUpload(new Uint8Array(1), "image/png"),
    ).rejects.toThrow("required image preview");
    expect(pipeline.toBuffer).toHaveBeenCalledTimes(70);
  });
});
