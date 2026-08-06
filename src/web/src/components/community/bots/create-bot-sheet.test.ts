import { describe, it, expect, vi, beforeEach } from "vitest"
import React from "react"
import TestRenderer, { act } from "react-test-renderer"

// --- Pure helper unit tests -------------------------------------------------

import {
  normalizeRuntimes,
  firstHealthyRuntimeId,
  firstOnlineMachineId,
} from "./create-bot-sheet"
import type { CommunityMachineSummary } from "@alook/shared"

function machine(over: Partial<CommunityMachineSummary>): CommunityMachineSummary {
  return {
    id: "m1",
    hostname: "host",
    displayName: "",
    platform: "darwin",
    arch: "arm64",
    osRelease: "",
    daemonVersion: "0",
    lastSeenAt: null,
    status: "online",
    availableRuntimes: [],
    createdAt: "",
    updatedAt: "",
    ...over,
  }
}

describe("firstOnlineMachineId", () => {
  it("returns the first online machine id, skipping a leading offline one", () => {
    const machines = [
      machine({ id: "off", status: "offline" }),
      machine({ id: "on", status: "online" }),
    ]
    expect(firstOnlineMachineId(machines)).toBe("on")
  })

  it("returns '' when no machine is online", () => {
    expect(firstOnlineMachineId([machine({ id: "a", status: "offline" })])).toBe("")
  })

  it("returns '' for an empty list", () => {
    expect(firstOnlineMachineId([])).toBe("")
  })
})

describe("normalizeRuntimes", () => {
  it("returns [] when availableRuntimes is missing", () => {
    expect(normalizeRuntimes(undefined)).toEqual([])
    // legacy summary missing the field entirely
    const legacy = { ...machine({}) } as CommunityMachineSummary
    delete (legacy as { availableRuntimes?: unknown }).availableRuntimes
    expect(normalizeRuntimes(legacy)).toEqual([])
  })

  it("normalizes bare-string legacy entries to healthy", () => {
    const m = machine({
      availableRuntimes: ["claude"] as unknown as CommunityMachineSummary["availableRuntimes"],
    })
    expect(normalizeRuntimes(m)).toEqual([{ id: "claude", unhealthy: false }])
  })

  it("marks status:'unhealthy' entries unhealthy and sorts healthy-first", () => {
    const m = machine({
      availableRuntimes: [
        { id: "sick", status: "unhealthy" },
        { id: "ok", status: "healthy" },
      ] as unknown as CommunityMachineSummary["availableRuntimes"],
    })
    expect(normalizeRuntimes(m)).toEqual([
      { id: "ok", unhealthy: false },
      { id: "sick", unhealthy: true },
    ])
  })
})

describe("firstHealthyRuntimeId", () => {
  it("returns the first healthy runtime id, skipping unhealthy ones", () => {
    expect(
      firstHealthyRuntimeId([
        { id: "ok", unhealthy: false },
        { id: "sick", unhealthy: true },
      ]),
    ).toBe("ok")
  })

  it("returns '' when every runtime is unhealthy", () => {
    expect(firstHealthyRuntimeId([{ id: "sick", unhealthy: true }])).toBe("")
  })

  it("returns '' for an empty list", () => {
    expect(firstHealthyRuntimeId([])).toBe("")
  })
})

// --- Component auto-select tests --------------------------------------------
//
// The Sheet is a base-ui Dialog that portals into `document`, unavailable
// under this repo's `environment: "node"` vitest config — so mock the sheet
// shell and heavy children to render passthrough, and mock the data/mutation
// hooks. What we assert is the *initial `checked` state* of the machine and
// runtime radios, which is all this change touches.

const useMachinesMock = vi.fn()

vi.mock("@/hooks/community/use-machines", () => ({
  useMachines: () => useMachinesMock(),
}))

vi.mock("@/hooks/community/use-bots", () => ({
  useCreateBot: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadBotAvatar: () => ({ mutateAsync: vi.fn() }),
}))

vi.mock("@/components/ui/sheet", () => {
  const pass = (name: string) =>
    function Passthrough({ children }: { children?: React.ReactNode }) {
      return React.createElement("div", { "data-mock": name }, children)
    }
  return {
    Sheet: pass("sheet"),
    SheetBody: pass("body"),
    SheetContent: pass("content"),
    SheetFooter: pass("footer"),
    SheetHeader: pass("header"),
    SheetTitle: pass("title"),
  }
})

const botFormFieldsRenders: Array<{ avatarDraft: { image?: string } }> = []
vi.mock("./bot-form-fields", () => ({
  BotFormFields: ({ avatarDraft }: { avatarDraft: { image?: string } }) => {
    botFormFieldsRenders.push({ avatarDraft })
    return React.createElement("div", { "data-mock": "form-fields" })
  },
}))

// Capture ModelField's incoming `value` so we can assert the create sheet
// resets the model to null (Default) on a runtime change.
const modelFieldRenders: Array<{ runtime: string | null; value: string | null }> = []
vi.mock("./model-field", () => ({
  ModelField: ({ runtime, value }: { runtime: string | null; value: string | null }) => {
    modelFieldRenders.push({ runtime, value })
    return React.createElement("div", { "data-mock": "model-field", "data-value": value ?? "" })
  },
}))

vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: () => React.createElement("span", { "data-mock": "provider-logo" }),
}))

import { CreateBotSheet } from "./create-bot-sheet"

type Radio = { name: string; value: string; checked: boolean }

function radios(renderer: TestRenderer.ReactTestRenderer, name: string): Radio[] {
  return renderer.root
    .findAll((n) => n.type === "input" && n.props.name === name)
    .map((n) => ({ name: n.props.name, value: n.props.value, checked: !!n.props.checked }))
}

function checkedValue(renderer: TestRenderer.ReactTestRenderer, name: string): string | null {
  return radios(renderer, name).find((r) => r.checked)?.value ?? null
}

function render(props: { avatarSeed?: string } = {}): TestRenderer.ReactTestRenderer {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(CreateBotSheet, { open: true, onOpenChange: vi.fn(), ...props }),
    )
  })
  return renderer
}

describe("CreateBotSheet — auto-select defaults", () => {
  beforeEach(() => {
    useMachinesMock.mockReset()
    botFormFieldsRenders.length = 0
  })

  it("uses the guide companion seed for a guided bot avatar", () => {
    useMachinesMock.mockReturnValue({ machines: [] })
    render({ avatarSeed: "guide-face-7" })

    expect(botFormFieldsRenders.at(-1)?.avatarDraft.image).toBe("avatar:beam:guide-face-7")
  })

  it("pre-checks the machine and runtime with one online machine + one healthy runtime", () => {
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    const renderer = render()
    expect(checkedValue(renderer, "bot-machine")).toBe("mac")
    expect(checkedValue(renderer, "bot-runtime")).toBe("claude")
  })

  it("resolves the [] → populated async race by auto-selecting once data arrives", () => {
    // First render: machines empty (query still loading).
    useMachinesMock.mockReturnValue({ machines: [] })
    const renderer = render()
    expect(checkedValue(renderer, "bot-machine")).toBe(null)

    // Data arrives a tick later — re-render the SAME instance.
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    act(() => {
      renderer.update(
        React.createElement(CreateBotSheet, { open: true, onOpenChange: vi.fn() }),
      )
    })
    expect(checkedValue(renderer, "bot-machine")).toBe("mac")
    expect(checkedValue(renderer, "bot-runtime")).toBe("claude")
  })

  it("skips a leading offline machine and picks the first online one", () => {
    useMachinesMock.mockReturnValue({
      machines: [
        machine({ id: "off", status: "offline" }),
        machine({
          id: "on",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    const renderer = render()
    expect(checkedValue(renderer, "bot-machine")).toBe("on")
  })

  it("selects nothing when no machine is online", () => {
    useMachinesMock.mockReturnValue({
      machines: [machine({ id: "off", status: "offline" })],
    })
    const renderer = render()
    expect(checkedValue(renderer, "bot-machine")).toBe(null)
    // Runtime section is hidden entirely when no machine is selected.
    expect(radios(renderer, "bot-runtime")).toHaveLength(0)
  })

  it("pre-selects the machine but not the runtime when the only runtime is unhealthy", () => {
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "sick", status: "unhealthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    const renderer = render()
    expect(checkedValue(renderer, "bot-machine")).toBe("mac")
    expect(checkedValue(renderer, "bot-runtime")).toBe(null)
  })

  it("resets the model to Default (null) when the user switches machine/runtime", () => {
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
        machine({
          id: "server",
          status: "online",
          availableRuntimes: [
            { id: "codex", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    modelFieldRenders.length = 0
    const renderer = render()
    // Switching machine (which re-defaults the runtime) hands ModelField a
    // fresh runtime with value null.
    const serverRadio = renderer.root.findAll(
      (n) => n.type === "input" && n.props.name === "bot-machine" && n.props.value === "server",
    )[0]
    act(() => {
      serverRadio.props.onChange()
    })
    const last = modelFieldRenders.at(-1)!
    expect(last.runtime).toBe("codex")
    expect(last.value).toBeNull()
  })

  it("re-defaults the runtime when the user switches to another machine", () => {
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
        machine({
          id: "server",
          status: "online",
          availableRuntimes: [
            { id: "codex", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    const renderer = render()
    expect(checkedValue(renderer, "bot-machine")).toBe("mac")
    expect(checkedValue(renderer, "bot-runtime")).toBe("claude")

    // Click the second machine's radio.
    const serverRadio = renderer.root.findAll(
      (n) => n.type === "input" && n.props.name === "bot-machine" && n.props.value === "server",
    )[0]
    act(() => {
      serverRadio.props.onChange()
    })
    expect(checkedValue(renderer, "bot-machine")).toBe("server")
    expect(checkedValue(renderer, "bot-runtime")).toBe("codex")
  })

  it("does not overwrite a chosen machine when a presence refetch changes the array", () => {
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
        machine({
          id: "server",
          status: "online",
          availableRuntimes: [
            { id: "codex", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    const renderer = render()

    // User picks the second machine explicitly.
    const serverRadio = renderer.root.findAll(
      (n) => n.type === "input" && n.props.name === "bot-machine" && n.props.value === "server",
    )[0]
    act(() => {
      serverRadio.props.onChange()
    })
    expect(checkedValue(renderer, "bot-machine")).toBe("server")

    // A presence tick delivers a NEW array identity (same data).
    useMachinesMock.mockReturnValue({
      machines: [
        machine({
          id: "mac",
          status: "online",
          availableRuntimes: [
            { id: "claude", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
        machine({
          id: "server",
          status: "online",
          availableRuntimes: [
            { id: "codex", status: "healthy" },
          ] as unknown as CommunityMachineSummary["availableRuntimes"],
        }),
      ],
    })
    act(() => {
      renderer.update(
        React.createElement(CreateBotSheet, { open: true, onOpenChange: vi.fn() }),
      )
    })
    // Choice stands.
    expect(checkedValue(renderer, "bot-machine")).toBe("server")
    expect(checkedValue(renderer, "bot-runtime")).toBe("codex")
  })
})
