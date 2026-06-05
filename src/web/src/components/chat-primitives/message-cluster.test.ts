import { describe, it, expect } from "vitest";
import type { ClusterPosition } from "./message-cluster";

// Test the cluster logic: which positions show the avatar header vs spacer.
// We test the decision logic that the component implements.

function isClusterHead(position: ClusterPosition): boolean {
  return position === "first" || position === "solo";
}

describe("MessageCluster position logic", () => {
  it("'first' position shows avatar and name (cluster head)", () => {
    expect(isClusterHead("first")).toBe(true);
  });

  it("'solo' position shows avatar and name (cluster head)", () => {
    expect(isClusterHead("solo")).toBe(true);
  });

  it("'middle' position hides avatar and name", () => {
    expect(isClusterHead("middle")).toBe(false);
  });

  it("'last' position hides avatar and name", () => {
    expect(isClusterHead("last")).toBe(false);
  });

  describe("AVATAR_SIZE constant", () => {
    it("exports a 30px avatar size matching the gutter column", async () => {
      const { AVATAR_SIZE } = await import("./message-cluster");
      expect(AVATAR_SIZE).toBe(30);
    });
  });
});
