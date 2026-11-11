import { describe, expect, it } from "vitest"
import { runtimeLabel, visibleRuntimes } from "./runtime-label"

describe("Codex source choices", () => {
  const runtimes = [{ id: "codex" }, { id: "codex-app" }, { id: "codex-cli" }, { id: "claude" }]
  it("shows only explicit choices on new daemons and labels them distinctly", () => {
    expect(visibleRuntimes(runtimes).map(({ id }) => runtimeLabel(id))).toEqual(["Codex", "Codex CLI", "claude"])
  })
  it("retains the legacy choice for older daemons and existing bot edits", () => {
    expect(visibleRuntimes([{ id: "codex" }])).toEqual([{ id: "codex" }])
    expect(visibleRuntimes(runtimes, "codex")).toEqual(runtimes)
    expect(runtimeLabel("codex")).toBe("Codex (automatic)")
  })
})
