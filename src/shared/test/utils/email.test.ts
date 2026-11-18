import { describe, it, expect } from "vitest"
import { toAlookAddress } from "../../src/utils/email"
describe("toAlookAddress", () => { it("appends domain", () => expect(toAlookAddress("jarvis")).toBe("jarvis@alook.ai")) })
