import { describe, expect, it } from "vitest"
import { runtimeLabel, visibleRuntimes } from "./runtime-label"

describe("Codex source choices", () => {
  const runtimes = [{ id: "codex" }, { id: "codex-app" }, { id: "codex-cli" }, { id: "claude" }]
  it("shows only explicit choices on new daemons and labels them distinctly", () => {
    expect(visibleRuntimes(runtimes).map(({ id }) => runtimeLabel(id))).toEqual(["Codex App", "Codex CLI", "claude"])
  })
  it("never offers the legacy alias for new bots, including older daemon reports", () => {
    expect(visibleRuntimes([{ id: "codex" }])).toEqual([])
    expect(visibleRuntimes(runtimes, "codex")).toEqual(runtimes)
    expect(runtimeLabel("codex")).toBe("Codex (automatic)")
  })
})
