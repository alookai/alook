import { describe, it, expect } from "vitest";
import * as agentQueries from "../../src/db/queries/agent";

describe("agent query module exports", () => {
  it("exports getExistingHandles", () => {
    expect(typeof agentQueries.getExistingHandles).toBe("function");
  });

  it("exports getAgentByHandle", () => {
    expect(typeof agentQueries.getAgentByHandle).toBe("function");
  });

  it("exports getAgentsByIds", () => {
    expect(typeof agentQueries.getAgentsByIds).toBe("function");
  });
});

describe("agent query function signatures", () => {
  it("getExistingHandles accepts (db, handles)", () => {
    expect(agentQueries.getExistingHandles.length).toBe(2);
  });

  it("getExistingHandles returns empty array for empty input", async () => {
    const result = await agentQueries.getExistingHandles(null as any, []);
    expect(result).toEqual([]);
  });
});
