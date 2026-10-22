import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  get: vi.fn(),
  render: vi.fn(),
  initialize: vi.fn(),
}))
vi.mock("@streamdown/mermaid", () => ({ createMermaidPlugin: mocks.create }))
vi.mock("./streamdown-remark-plugins", () => ({ cjk: {}, math: {} }))

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.create.mockImplementation(() => ({ getMermaid: mocks.get }))
  mocks.get.mockReturnValue({ render: mocks.render, initialize: mocks.initialize })
  mocks.render.mockResolvedValue({ svg: '<svg aria-label="Diagram" />' })
})

describe("deferred diagram engine", () => {
  it("loads on first render, retains the existing appearance, and reuses the engine", async () => {
    const { mermaid } = await import("./streamdown-plugins")
    const instance = mermaid.getMermaid()
    expect(mocks.create).not.toHaveBeenCalled()
    expect(await instance.render("one", "graph TD; A-->B")).toEqual({ svg: '<svg aria-label="Diagram" />' })
    expect(mocks.create).toHaveBeenCalledWith({ config: expect.objectContaining({
      theme: "base", fontFamily: "ui-sans-serif, system-ui, sans-serif",
      themeVariables: expect.objectContaining({ primaryColor: "#eceae6", primaryTextColor: "#2d2a26" }),
    }) })
    await instance.render("two", "graph TD; C-->D")
    expect(mocks.create).toHaveBeenCalledTimes(1)
    expect(mocks.render).toHaveBeenLastCalledWith("two", "graph TD; C-->D")
  })

  it("preserves initial and updated configuration and forwards rendering errors", async () => {
    const { mermaid } = await import("./streamdown-plugins")
    const instance = mermaid.getMermaid({ theme: "dark" })
    await instance.render("one", "graph TD; A-->B")
    expect(mocks.initialize).toHaveBeenLastCalledWith({ theme: "dark" })
    instance.initialize({ theme: "forest" })
    const error = new Error("invalid diagram")
    mocks.render.mockRejectedValueOnce(error)
    await expect(instance.render("bad", "invalid")).rejects.toBe(error)
    expect(mocks.initialize).toHaveBeenLastCalledWith({ theme: "forest" })
    await expect(instance.render("next", "graph TD; A-->B")).resolves.toHaveProperty("svg")
  })

  it("captures each concurrent render configuration and does not reinitialize repeated renders", async () => {
    const { mermaid } = await import("./streamdown-plugins")
    const seen: string[] = []
    let theme = "default"
    mocks.initialize.mockImplementation((config) => { theme = config.theme })
    mocks.render.mockImplementation(async () => { seen.push(theme); return { svg: "<svg />" } })
    const dark = mermaid.getMermaid({ theme: "dark" }).render("dark", "graph TD; A-->B")
    const forest = mermaid.getMermaid({ theme: "forest" }).render("forest", "graph TD; C-->D")
    await Promise.all([dark, forest])
    expect(seen).toEqual(["dark", "forest"])
    expect(mocks.initialize).toHaveBeenCalledTimes(2)
    await mermaid.getMermaid().render("again", "graph TD; E-->F")
    expect(mocks.initialize).toHaveBeenCalledTimes(2)
  })

  it("allows retry if engine initialization fails", async () => {
    const { mermaid } = await import("./streamdown-plugins")
    const error = new Error("engine unavailable")
    mocks.create.mockImplementationOnce(() => { throw error })
    const instance = mermaid.getMermaid()
    await expect(instance.render("one", "graph TD; A-->B")).rejects.toBe(error)
    await expect(instance.render("two", "graph TD; A-->B")).resolves.toHaveProperty("svg")
    expect(mocks.create).toHaveBeenCalledTimes(2)
  })
})
