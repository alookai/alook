import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@alook/shared", async () => {
  const actual = await vi.importActual<typeof import("@alook/shared")>("@alook/shared");
  return {
    ...actual,
    createLogger: () => ({ warn }),
  };
});

import {
  COMMUNITY_MEDIA_DELETE_BATCH_SIZE,
  scheduleForumPostMediaCleanup,
} from "./forum-post-media-cleanup";

describe("scheduleForumPostMediaCleanup", () => {
  const deleteObjects = vi.fn<(keys: string[]) => Promise<void>>();
  const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();

  beforeEach(() => {
    vi.clearAllMocks();
    deleteObjects.mockResolvedValue(undefined);
  });

  it("deduplicates keys and registers the complete delete with waitUntil", async () => {
    scheduleForumPostMediaCleanup(
      { delete: deleteObjects } as Pick<R2Bucket, "delete">,
      { waitUntil },
      {
        openerId: "opener_1",
        childChannelId: "child_1",
        keys: ["original", "thumbnail", "original", ""],
      },
    );

    expect(waitUntil).toHaveBeenCalledTimes(1);
    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(deleteObjects).toHaveBeenCalledWith(["original", "thumbnail"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("chunks at the R2 1000-key multi-delete limit", async () => {
    const keys = Array.from(
      { length: COMMUNITY_MEDIA_DELETE_BATCH_SIZE + 1 },
      (_, index) => `key-${index}`,
    );
    scheduleForumPostMediaCleanup(
      { delete: deleteObjects } as Pick<R2Bucket, "delete">,
      { waitUntil },
      { openerId: "opener_1", childChannelId: "child_1", keys },
    );

    await waitUntil.mock.calls[0]![0];
    expect(deleteObjects).toHaveBeenCalledTimes(2);
    expect(deleteObjects.mock.calls[0]![0]).toHaveLength(COMMUNITY_MEDIA_DELETE_BATCH_SIZE);
    expect(deleteObjects.mock.calls[1]![0]).toEqual([`key-${COMMUNITY_MEDIA_DELETE_BATCH_SIZE}`]);
  });

  it("does not register work for an empty key set", () => {
    scheduleForumPostMediaCleanup(
      { delete: deleteObjects } as Pick<R2Bucket, "delete">,
      { waitUntil },
      { openerId: "opener_1", childChannelId: "child_1", keys: [""] },
    );

    expect(waitUntil).not.toHaveBeenCalled();
    expect(deleteObjects).not.toHaveBeenCalled();
  });

  it("absorbs R2 failure and logs only a non-secret error category", async () => {
    deleteObjects.mockRejectedValueOnce(new Error("secret/key/original: provider detail"));
    scheduleForumPostMediaCleanup(
      { delete: deleteObjects } as Pick<R2Bucket, "delete">,
      { waitUntil },
      {
        openerId: "opener_1",
        childChannelId: "child_1",
        keys: ["original", "thumbnail"],
      },
    );

    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("forum_post_media_cleanup_failed", {
      openerId: "opener_1",
      childChannelId: "child_1",
      keyCount: 2,
      errorCategory: "Error",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret/key/original");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("provider detail");
  });

  it("sanitizes non-Error rejections", async () => {
    deleteObjects.mockRejectedValueOnce("secret provider rejection");
    scheduleForumPostMediaCleanup(
      { delete: deleteObjects } as Pick<R2Bucket, "delete">,
      { waitUntil },
      { openerId: "opener_1", childChannelId: "child_1", keys: ["original"] },
    );

    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("forum_post_media_cleanup_failed", {
      openerId: "opener_1",
      childChannelId: "child_1",
      keyCount: 1,
      errorCategory: "NonError",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret provider rejection");
  });

  it("classifies TypeError rejections without logging their message", async () => {
    deleteObjects.mockRejectedValueOnce(new TypeError("secret type detail"));
    scheduleForumPostMediaCleanup(
      { delete: deleteObjects } as Pick<R2Bucket, "delete">,
      { waitUntil },
      { openerId: "opener_1", childChannelId: "child_1", keys: ["original"] },
    );

    await expect(waitUntil.mock.calls[0]![0]).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("forum_post_media_cleanup_failed", {
      openerId: "opener_1",
      childChannelId: "child_1",
      keyCount: 1,
      errorCategory: "TypeError",
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret type detail");
  });
});
