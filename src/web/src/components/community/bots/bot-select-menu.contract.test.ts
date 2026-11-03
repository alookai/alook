import staticContractInput0 from "./model-field.tsx?raw"
import staticContractInput1 from "./reasoning-effort-field.tsx?raw"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const directory = dirname(fileURLToPath(import.meta.url))

describe("bot select menu spacing", () => {
  it("keeps model and effort menus on the same content and row owners", () => {
    const modelSource = staticContractInput0
    const effortSource = staticContractInput1

    expect(modelSource).toContain("<BotSelectMenuContent")
    expect(modelSource).toContain("<BotSelectMenuItem")
    expect(effortSource).toContain("<BotSelectMenuContent")
    expect(effortSource).toContain("<BotSelectMenuItem")
  })
})
