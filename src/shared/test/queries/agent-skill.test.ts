import { describe, it, expect } from "vitest";
import * as agentSkillQueries from "../../src/db/queries/agent-skill";

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
  it("syncGlobalSkills accepts (db, workspaceId, runtime, skills)", () => {
    expect(agentSkillQueries.syncGlobalSkills.length).toBe(4);
  });
  it("syncAgentSkills accepts (db, agentId, runtime, workspaceId, skills)", () => {
    expect(agentSkillQueries.syncAgentSkills.length).toBe(5);
  });
  it("getSkills accepts (db, agentId, runtime, workspaceId)", () => {
    expect(agentSkillQueries.getSkills.length).toBe(4);
  });
});
