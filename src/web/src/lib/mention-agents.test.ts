import { describe, it, expect } from "vitest";
import type { Agent, AgentLink } from "@alook/shared";
import { relatedAgentIdSet, filterAgentsByQuery, rankMentionAgents } from "./mention-agents";

const agent = (id: string, name: string): Agent =>
  ({ id, name } as Agent);

const link = (source: string, target: string): AgentLink =>
  ({ source_agent_id: source, target_agent_id: target } as AgentLink);

describe("relatedAgentIdSet", () => {
  it("collects linked agents in both directions", () => {
    const links = [link("me", "alice"), link("bob", "me"), link("x", "y")];
    const set = relatedAgentIdSet(links, "me");
    expect([...set].sort()).toEqual(["alice", "bob"]);
  });

  it("returns empty when no links touch the current agent", () => {
    expect(relatedAgentIdSet([link("x", "y")], "me").size).toBe(0);
  });
});

describe("filterAgentsByQuery", () => {
  const list = [agent("1", "Alice"), agent("2", "Albert"), agent("3", "Bob"), agent("4", "Calbert")];

  it("returns the list unchanged for an empty query", () => {
    expect(filterAgentsByQuery(list, "")).toBe(list);
  });

  it("ranks prefix matches before substring matches", () => {
    // query "al": Alice/Albert start with it; Calbert only contains it
    const names = filterAgentsByQuery(list, "al").map((a) => a.name);
    expect(names).toEqual(["Alice", "Albert", "Calbert"]);
  });

  it("is case-insensitive", () => {
    expect(filterAgentsByQuery(list, "BOB").map((a) => a.name)).toEqual(["Bob"]);
  });
});

describe("rankMentionAgents", () => {
  const agents = [agent("alice", "Alice"), agent("bob", "Bob"), agent("carol", "Carol")];
  const links = [link("me", "carol")]; // carol is related to me

  it("puts related agents first, then others", () => {
    const out = rankMentionAgents(agents, links, "me", "").map((a) => a.name);
    expect(out[0]).toBe("Carol");
    expect(out.slice(1).sort()).toEqual(["Alice", "Bob"]);
  });

  it("applies the query within both groups", () => {
    const out = rankMentionAgents(
      [agent("ca", "Cara"), agent("co", "Cody"), agent("al", "Alan")],
      [link("me", "ca")],
      "me",
      "c",
    ).map((a) => a.name);
    // related first (Cara), then other matches (Cody); Alan filtered out
    expect(out).toEqual(["Cara", "Cody"]);
  });

  it("respects the limit", () => {
    const many = Array.from({ length: 30 }, (_, i) => agent(`a${i}`, `Agent${i}`));
    expect(rankMentionAgents(many, [], "me", "", 20)).toHaveLength(20);
  });
});
