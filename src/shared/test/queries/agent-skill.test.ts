import { describe, it, expect, vi } from "vitest";
import * as agentSkillQueries from "../../src/db/queries/agent-skill";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("agent-skill query module exports", () => {
  it("exports syncGlobalSkills", () => {
    expect(typeof agentSkillQueries.syncGlobalSkills).toBe("function");
  });
  it("exports syncAgentSkills", () => {
    expect(typeof agentSkillQueries.syncAgentSkills).toBe("function");
  });
  it("exports getSkills", () => {
    expect(typeof agentSkillQueries.getSkills).toBe("function");
  });
});

describe("agent-skill query function signatures", () => {
  it("syncGlobalSkills accepts (db, workspaceId, runtime, skills, daemonId?)", () => {
    expect(agentSkillQueries.syncGlobalSkills.length).toBe(5);
  });
  it("syncAgentSkills accepts (db, agentId, runtime, workspaceId, skills)", () => {
    expect(agentSkillQueries.syncAgentSkills.length).toBe(5);
  });
  it("getSkills accepts (db, agentId, runtime, workspaceId)", () => {
    expect(agentSkillQueries.getSkills.length).toBe(4);
  });
});

describe("getSkills", () => {
  it("returns empty array when no skills found", async () => {
    const mockDb = createMockDb([]);
    const result = await agentSkillQueries.getSkills(mockDb, "ag_1", "local", "ws_1");
    expect(result).toEqual([]);
  });

  it("returns skills and deduplicates global skills by name", async () => {
    const rows = [
      { name: "code-review", description: "Reviews code", isGlobal: true },
      { name: "code-review", description: "Reviews code (dup)", isGlobal: true },
      { name: "deploy", description: "Deploys apps", isGlobal: false },
    ];
    const mockDb = createMockDb(rows);
    const result = await agentSkillQueries.getSkills(mockDb, "ag_1", "local", "ws_1");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("code-review");
    expect(result[0].description).toBe("Reviews code");
    expect(result[1].name).toBe("deploy");
  });

  it("does not deduplicate across global and agent scopes", async () => {
    const rows = [
      { name: "review", description: "Global review", isGlobal: true },
      { name: "review", description: "Agent review", isGlobal: false },
    ];
    const mockDb = createMockDb(rows);
    const result = await agentSkillQueries.getSkills(mockDb, "ag_1", "local", "ws_1");
    expect(result).toHaveLength(2);
  });
});
