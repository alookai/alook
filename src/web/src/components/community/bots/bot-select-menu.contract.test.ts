import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const directory = dirname(fileURLToPath(import.meta.url))

describe("bot select menu spacing", () => {
  it("keeps model and effort menus on the same content and row owners", () => {
    const modelSource = readFileSync(resolve(directory, "model-field.tsx"), "utf8")
    const effortSource = readFileSync(resolve(directory, "reasoning-effort-field.tsx"), "utf8")

    expect(modelSource).toContain("<BotSelectMenuContent")
    expect(modelSource).toContain("<BotSelectMenuItem")
    expect(effortSource).toContain("<BotSelectMenuContent")
    expect(effortSource).toContain("<BotSelectMenuItem")
  })
})
