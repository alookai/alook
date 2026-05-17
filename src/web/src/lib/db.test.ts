import { describe, it, expect, vi } from "vitest";
import { withD1Retry } from "./db";

describe("withD1Retry", () => {
  it("returns result on first success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await withD1Retry(fn);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries once on transient failure then succeeds", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("D1 timeout"))
      .mockResolvedValueOnce("recovered");
    const result = await withD1Retry(fn);
    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after all retries exhausted", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("D1 down"));
    await expect(withD1Retry(fn)).rejects.toThrow("D1 down");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("respects custom retry count", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(withD1Retry(fn, 3)).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it("does not retry when retries is 0", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("fail"));
    await expect(withD1Retry(fn, 0)).rejects.toThrow("fail");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
