import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const directory = dirname(fileURLToPath(import.meta.url))

describe("bot select menu spacing", () => {
  it("gives model and effort menus a shared padded content and row rhythm", () => {
    const menuSource = readFileSync(resolve(directory, "bot-select-menu.tsx"), "utf8")
    const modelSource = readFileSync(resolve(directory, "model-field.tsx"), "utf8")
    const effortSource = readFileSync(resolve(directory, "reasoning-effort-field.tsx"), "utf8")

    expect(menuSource).toContain('cn("p-1.5", className)')
    expect(menuSource).toContain('cn("min-h-10 py-2 pr-9 pl-3 leading-snug", className)')
    expect(modelSource).toContain("<BotSelectMenuContent")
    expect(modelSource).toContain("<BotSelectMenuItem")
    expect(effortSource).toContain("<BotSelectMenuContent")
    expect(effortSource).toContain("<BotSelectMenuItem")
  })
})
