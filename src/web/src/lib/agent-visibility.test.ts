import { describe, it, expect } from "vitest";
import { filterVisibleAgents } from "./agent-visibility";

const makeAgent = (id: string, visibility: string, ownerId: string | null) => ({
  id,
  visibility,
  ownerId,
  name: `Agent ${id}`,
});

describe("filterVisibleAgents", () => {
  const agents = [
    makeAgent("a1", "public", "owner1"),
    makeAgent("a2", "private", "owner1"),
    makeAgent("a3", "private", "owner2"),
    makeAgent("a4", "private", "owner3"),
  ];

  it("returns public agents for any user", () => {
    const result = filterVisibleAgents(agents, "random_user", []);
    expect(result.map((a) => a.id)).toEqual(["a1"]);
  });

  it("returns agents owned by the user regardless of visibility", () => {
    const result = filterVisibleAgents(agents, "owner1", []);
    expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("returns private agents the user has explicit access to", () => {
    const access = [{ agentId: "a3", userId: "user_x" }];
    const result = filterVisibleAgents(agents, "user_x", access);
    expect(result.map((a) => a.id)).toEqual(["a1", "a3"]);
  });

  it("does not duplicate when user owns AND has access", () => {
    const access = [{ agentId: "a2", userId: "owner1" }];
    const result = filterVisibleAgents(agents, "owner1", access);
    expect(result.map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("returns empty when no agents match", () => {
    const agents = [makeAgent("a1", "private", "owner1")];
    const result = filterVisibleAgents(agents, "nobody", []);
    expect(result).toEqual([]);
  });

  it("filters access list by userId correctly", () => {
    const access = [
      { agentId: "a3", userId: "user_a" },
      { agentId: "a4", userId: "user_b" },
    ];
    const result = filterVisibleAgents(agents, "user_a", access);
    expect(result.map((a) => a.id)).toEqual(["a1", "a3"]);
  });
});
