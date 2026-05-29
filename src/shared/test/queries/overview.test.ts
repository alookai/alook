import { describe, it, expect } from "vitest";
import * as overviewQueries from "../../src/db/queries/overview";

describe("overview query module exports", () => {
  it("exports getEmailStatsByWorkspace", () => {
    expect(typeof overviewQueries.getEmailStatsByWorkspace).toBe("function");
  });

  it("exports getEmailAccountsByWorkspace", () => {
    expect(typeof overviewQueries.getEmailAccountsByWorkspace).toBe("function");
  });

  it("exports getTaskStatsByWorkspace", () => {
    expect(typeof overviewQueries.getTaskStatsByWorkspace).toBe("function");
  });

  it("exports getRecentTerminalTasks", () => {
    expect(typeof overviewQueries.getRecentTerminalTasks).toBe("function");
  });

  it("exports getConversationCountsByAgent", () => {
    expect(typeof overviewQueries.getConversationCountsByAgent).toBe("function");
  });
});

describe("getRecentTerminalTasks", () => {
  it("returns empty array for empty visibleAgentIds without querying DB", async () => {
    const result = await overviewQueries.getRecentTerminalTasks(null as any, "ws_1", []);
    expect(result).toEqual([]);
  });
});

describe("getConversationCountsByAgent", () => {
  it("returns empty array for empty visibleAgentIds without querying DB", async () => {
    const result = await overviewQueries.getConversationCountsByAgent(null as any, "ws_1", []);
    expect(result).toEqual([]);
  });
});
