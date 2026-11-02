import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as facade from "./bot-list"

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..")
const source = (path: string) => readFileSync(resolve(webRoot, path), "utf8")

describe("BotList facade contract", () => {
  it("exposes the public component without internal runtime exports", () => {
    expect(Object.keys(facade)).toEqual(["BotList"])
  })

  it("keeps the production page and existing regression on the original path", () => {
    const page = source("src/components/community/shell/community-module-route.tsx")
    const existingTest = source("src/components/community/bots/bot-list-card.dom.test.ts")
    const consumer = source("src/components/community/bots/me-bots-route.tsx")
    expect(page).toContain('import BotsRoute from "../bots/me-bots-route"')
    expect(consumer).toContain('from "@/components/community/bots/bot-list"')
    expect(existingTest).toContain('from "./bot-list"')
    expect(`${page}\n${existingTest}`).not.toMatch(
      /bot-list-(types|controller|view|machine-group|overlays)/,
    )
  })

  it("keeps all internals private to the bot-list implementation", () => {
    const types = source("src/components/community/bots/bot-list-types.ts")
    expect(types).not.toMatch(/^export (?:const|function|class|let|var) /m)
    expect(source("src/components/community/bots/bot-list-controller.ts"))
      .not.toMatch(/from ["']@\/components\/community\//)
  })
})
