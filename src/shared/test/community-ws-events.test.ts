import { describe, it, expect } from "vitest";
import { isCommunityEvent } from "../src/community-ws-events";

describe("isCommunityEvent", () => {
  it("returns true for community:machine.created", () => {
    expect(isCommunityEvent({ type: "community:machine.created" })).toBe(true);
  });
  it("returns true for community:machine.status", () => {
    expect(isCommunityEvent({ type: "community:machine.status" })).toBe(true);
  });
  it("returns true for community:machine.removed", () => {
    expect(isCommunityEvent({ type: "community:machine.removed" })).toBe(true);
  });
  it("returns false for non-community events", () => {
    expect(isCommunityEvent({ type: "foo:bar" })).toBe(false);
    expect(isCommunityEvent({ type: "runtime.status" })).toBe(false);
  });
});
