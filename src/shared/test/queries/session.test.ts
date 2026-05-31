import { describe, it, expect, vi } from "vitest";
import * as sessionQueries from "../../src/db/queries/session";

function createMockDb(rows: any[]) {
  const chain: any = {};
  chain.select = vi.fn(() => chain);
  chain.from = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

describe("session exports", () => {
  it("exports getValidSession", () => { expect(typeof sessionQueries.getValidSession).toBe("function"); });
});

describe("getValidSession", () => {
  it("returns null when no valid session", async () => { expect(await sessionQueries.getValidSession(createMockDb([]), "tok")).toBeNull(); });
  it("returns userId when valid", async () => { expect(await sessionQueries.getValidSession(createMockDb([{ userId: "u_1" }]), "tok")).toBe("u_1"); });
});
