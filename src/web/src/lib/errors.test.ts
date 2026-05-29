import { describe, it, expect } from "vitest";
import { ApiError } from "./errors.js";

describe("ApiError", () => {
  it("creates an error with message and status", () => {
    const err = new ApiError("not found", 404);
    expect(err.message).toBe("not found");
    expect(err.status).toBe(404);
    expect(err.name).toBe("ApiError");
  });

  it("stores optional details array", () => {
    const err = new ApiError("bad request", 400, ["field is required", "name too long"]);
    expect(err.details).toEqual(["field is required", "name too long"]);
  });

  it("details is undefined when not provided", () => {
    const err = new ApiError("server error", 500);
    expect(err.details).toBeUndefined();
  });

  it("is an instance of Error", () => {
    const err = new ApiError("test", 500);
    expect(err).toBeInstanceOf(Error);
  });

  describe("isNetworkError", () => {
    it("returns true for status 0", () => {
      const err = new ApiError("network", 0);
      expect(err.isNetworkError).toBe(true);
    });

    it("returns false for other statuses", () => {
      expect(new ApiError("", 500).isNetworkError).toBe(false);
      expect(new ApiError("", 404).isNetworkError).toBe(false);
    });
  });

  describe("isRateLimit", () => {
    it("returns true for status 429", () => {
      const err = new ApiError("rate limited", 429);
      expect(err.isRateLimit).toBe(true);
    });

    it("returns false for other statuses", () => {
      expect(new ApiError("", 500).isRateLimit).toBe(false);
      expect(new ApiError("", 400).isRateLimit).toBe(false);
    });
  });

  describe("isUnauthorized", () => {
    it("returns true for status 401", () => {
      const err = new ApiError("unauthorized", 401);
      expect(err.isUnauthorized).toBe(true);
    });

    it("returns false for other statuses", () => {
      expect(new ApiError("", 403).isUnauthorized).toBe(false);
      expect(new ApiError("", 200).isUnauthorized).toBe(false);
    });
  });
});
