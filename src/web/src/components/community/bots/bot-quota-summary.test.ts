import React, { createContext, useContext } from "react"
import TestRenderer, { act } from "react-test-renderer"
import { describe, expect, it, vi } from "vitest"
import type { QuotaLimit } from "@alook/shared"
import type { MachineBackendQuota } from "@/hooks/community/use-machines"

vi.mock("lucide-react", () => ({ ChevronDown: "chevron-icon" }))
vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: (props: unknown) => React.createElement("provider-logo", props as Record<string, unknown>),
}))

const PopoverContext = createContext<{
  open: boolean
  onOpenChange: (open: boolean) => void
}>({ open: false, onOpenChange: () => undefined })

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ open, onOpenChange, children }: React.PropsWithChildren<{
    open: boolean
    onOpenChange: (open: boolean) => void
  }>) => React.createElement(PopoverContext.Provider, { value: { open, onOpenChange } }, children),
  PopoverTrigger: ({ render }: { render: React.ReactElement }) => {
    const context = useContext(PopoverContext)
    return React.cloneElement(render, { onClick: () => context.onOpenChange(!context.open) })
  },
  PopoverContent: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => {
    const context = useContext(PopoverContext)
    return context.open ? React.createElement("popover-content", props, children) : null
  },
}))

vi.mock("@/lib/time", () => ({ timeAgo: () => "2m ago" }))

import {
  MachineQuotaSummary,
  groupQuotaLimits,
  quotaBucketIdentity,
  remainingPercent,
  selectMostConstrainedLimit,
} from "./bot-quota-summary"

function limit({
  limitId = "primary",
  productId = "spark",
  productName = "Spark",
  modelId = "gpt-5.3-codex-spark",
  window = { kind: "rolling" as const, durationSeconds: 18_000, displayName: "5 hour usage limit" },
  usedPercent = 82,
  resetsAt,
}: Partial<{
  limitId: string
  productId: string
  productName: string
  modelId: string
  window: QuotaLimit["bucket"]["window"]
  usedPercent: number
  resetsAt: string
}> = {}): QuotaLimit {
  return {
    bucket: {
      limitId,
      product: { kind: "reported", id: productId, displayName: productName },
      model: { kind: "reported", id: modelId },
      window,
    },
    usedPercent,
    ...(resetsAt ? { resetsAt } : {}),
  }
}

function quotaEntry(
  limits: QuotaLimit[],
  status: "available" | "stale" = "available",
  backend = "codex",
): MachineBackendQuota {
  return {
    scope: { kind: "machine_backend", machineId: "m1", agentBackendId: backend },
    capability: "supported",
    runtimeState: "healthy",
    snapshot: {
      status,
      observedAt: "2026-08-29T00:00:00.000Z",
      planName: "Plus",
      limits,
    },
  }
}

function render(entries?: MachineBackendQuota[]) {
  let renderer!: TestRenderer.ReactTestRenderer
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(MachineQuotaSummary, { machineId: "m1", entries }),
    )
  })
  return renderer
}

function text(node: TestRenderer.ReactTestInstance): string {
  return node.children.map((child) => typeof child === "string" ? child : text(child)).join(" ")
}

describe("quota helpers", () => {
  it("uses only canonical identity fields for stable bucket keys", () => {
    const first = limit({ usedPercent: 82, productName: "Spark", resetsAt: "2026-08-30T00:00:00Z" })
    const relabeled = limit({ usedPercent: 10, productName: "Spark Plus", resetsAt: "2026-09-01T00:00:00Z" })
    expect(quotaBucketIdentity(first)).toBe(quotaBucketIdentity(relabeled))
  })

  it("selects lowest remaining, then earliest reset, then canonical identity", () => {
    const loose = limit({ limitId: "loose", usedPercent: 20 })
    const later = limit({ limitId: "later", usedPercent: 80, resetsAt: "2026-08-31T00:00:00Z" })
    const sooner = limit({ limitId: "sooner", usedPercent: 80, resetsAt: "2026-08-30T00:00:00Z" })
    expect(selectMostConstrainedLimit([loose, later, sooner])).toBe(sooner)
    expect(remainingPercent(sooner)).toBe(20)

    const a = limit({ limitId: "a", usedPercent: 80 })
    const b = limit({ limitId: "b", usedPercent: 80 })
    expect(selectMostConstrainedLimit([b, a])).toBe(a)
  })

  it("keeps Spark rolling and weekly windows distinct in one product/model group", () => {
    const rolling = limit()
    const weekly = limit({
      limitId: "weekly",
      window: { kind: "calendar", period: "week", displayName: "Weekly usage limit" },
      usedPercent: 55.5,
    })
    const groups = groupQuotaLimits([rolling, weekly])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.limits.map(quotaBucketIdentity)).toHaveLength(2)
    expect(new Set(groups[0]!.limits.map(quotaBucketIdentity)).size).toBe(2)
  })
})

describe("MachineQuotaSummary", () => {
  it("renders one machine-level summary and groups every backend in complete detail", () => {
    const rolling = limit({ usedPercent: 82 })
    const weekly = limit({
      limitId: "weekly",
      window: { kind: "calendar", period: "week", displayName: "Weekly usage limit" },
      usedPercent: 55.5,
    })
    const codex = quotaEntry([weekly, rolling])
    const pi: MachineBackendQuota = {
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "pi" },
      capability: "unsupported",
      runtimeState: "healthy",
      snapshot: { status: "pending" },
    }
    const claude: MachineBackendQuota = {
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "claude" },
      capability: "supported",
      runtimeState: "healthy",
      snapshot: { status: "pending" },
    }
    const renderer = render([pi, codex, claude])
    const trigger = renderer.root.findByProps({ "data-testid": "community-machine-quota-m1" })
    expect(trigger.props["aria-expanded"]).toBe(false)
    expect(text(trigger)).toContain("Quota · Spark · 18% left · 2 limits")

    act(() => trigger.props.onClick())
    expect(renderer.root.findByProps({ "data-testid": "community-machine-quota-m1" }).props["aria-expanded"])
      .toBe(true)
    const detail = renderer.root.findByProps({ "data-testid": "community-machine-quota-detail-m1" })
    expect(text(detail)).toContain("Machine quota")
    expect(text(detail)).toContain("Claude")
    expect(text(detail)).toContain("Codex")
    expect(text(detail)).toContain("Pi")
    expect(text(detail)).toContain("Pending")
    expect(text(detail)).toContain("Not supported")
    expect(text(detail)).toContain("5 hour usage limit")
    expect(text(detail)).toContain("Weekly usage limit")
    expect(text(detail)).toContain("18% left")
    expect(text(detail)).toContain("44.5% left")
    expect(text(detail)).toContain("2m ago")
    expect(detail.findAllByType("provider-logo").map((node) => node.props.provider))
      .toEqual(["claude", "codex", "pi"])
  })

  it("shows one limit's server-authored window and stale state", () => {
    const renderer = render([quotaEntry([limit({ usedPercent: 37.5 })], "stale")])
    const trigger = renderer.root.findByProps({ "data-testid": "community-machine-quota-m1" })
    expect(text(trigger)).toContain("Quota · Spark · 62.5% left")
    expect(text(trigger)).toContain("Stale")
  })

  it("renders honest fixed-height placeholders for missing capability states", () => {
    expect(text(render().root)).toContain("Quota unavailable")
    const unsupported = render([{
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "pi" },
      capability: "unsupported",
      runtimeState: "healthy",
      snapshot: { status: "pending" },
    }])
    expect(text(unsupported.root)).toContain("Quota not supported")
    expect(unsupported.root.findByType("provider-logo").props.provider).toBe("pi")
    expect(text(render([{
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "codex" },
      capability: "supported",
      runtimeState: "offline",
      snapshot: { status: "pending" },
    }]).root)).toContain("Quota pending")
  })
})
