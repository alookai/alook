import { readFileSync } from "node:fs"
import React, { type ComponentProps, type ComponentRef } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  controllerValue: { marker: "controller" },
  controller: vi.fn(),
  view: vi.fn(),
}))

vi.mock("./bot-list-controller", () => ({
  useBotListController: () => {
    mocks.controller()
    return mocks.controllerValue
  },
}))
vi.mock("./bot-list-view", () => ({
  renderBotListView: (props: unknown, controller: unknown) => {
    mocks.view(props, controller)
    return React.createElement("bot-list-view")
  },
}))

import * as facade from "./bot-list"

type ExpectedBotListProps = {
  onBack?: () => void
}

const source = (path: string) => readFileSync(path, "utf8")

describe("BotList facade contract", () => {
  beforeEach(() => vi.clearAllMocks())

  it("keeps the exact public surface and omitted-props default", () => {
    expect(Object.keys(facade)).toEqual(["BotList"])
    expectTypeOf<ComponentProps<typeof facade.BotList>>().toEqualTypeOf<ExpectedBotListProps>()
    expectTypeOf<ExpectedBotListProps>().toEqualTypeOf<ComponentProps<typeof facade.BotList>>()
    expectTypeOf<ComponentRef<typeof facade.BotList>>().toEqualTypeOf<never>()

    const text = source("src/components/community/bots/bot-list.tsx")
    expect(text).toContain("export function BotList({ onBack }: BotListProps = {})")
    expect(text).toContain("const controller = useBotListController()")
    expect(text).toContain("return renderBotListView({ onBack }, controller)")
    expect(text).not.toMatch(/<BotListView\b|createElement\(BotListView/)
    expect(text).not.toMatch(/forwardRef|useImperativeHandle/)
  })

  it("invokes the controller and plain view exactly once with omitted props resolved", () => {
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(React.createElement(facade.BotList))
    })
    expect(renderer.root.findAllByType("bot-list-view")).toHaveLength(1)
    expect(mocks.controller).toHaveBeenCalledOnce()
    expect(mocks.view).toHaveBeenCalledOnce()
    expect(mocks.view).toHaveBeenCalledWith({ onBack: undefined }, mocks.controllerValue)

    const onBack = vi.fn()
    act(() => renderer.update(React.createElement(facade.BotList, { onBack })))
    expect(mocks.controller).toHaveBeenCalledTimes(2)
    expect(mocks.view).toHaveBeenLastCalledWith({ onBack }, mocks.controllerValue)
  })

  it("keeps the production page and existing regression on the original path", () => {
    const page = source("src/app/c/me/bots/page.tsx")
    const existingTest = source("src/components/community/bots/bot-list-card.test.ts")
    expect(page).toContain('from "@/components/community/bots/bot-list"')
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
