import React, { createContext, useContext } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render as renderDom } from "@/test/react-dom-harness"
import type { QuotaLimit } from "@alook/shared"
import type { MachineBackendQuota } from "@/hooks/community/use-machines"

vi.mock("@/components/icons/lucide", () => ({ ChevronDown: "chevron-icon" }))
vi.mock("@/components/provider-logo", () => ({
  ProviderLogo: ({ provider }: { provider: string }) => React.createElement("div", {
    "data-provider-logo": provider,
  }),
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
  sortQuotaEntries,
  summarizeQuotaEntries,
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
  return renderDom(React.createElement(MachineQuotaSummary, { machineId: "m1", entries }))
}

function text(node: Element): string {
  return node.textContent!.replace(/\s+/g, " ").trim()
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

  it("summarizes every backend with data and sorts data ahead of placeholders", () => {
    const codex = quotaEntry([limit({ usedPercent: 82 })], "available", "codex")
    const grok = quotaEntry([limit({ usedPercent: 35 })], "available", "grok")
    const claude: MachineBackendQuota = {
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "claude" },
      capability: "supported",
      runtimeState: "healthy",
      snapshot: { status: "pending" },
    }

    expect(summarizeQuotaEntries([grok, claude, codex]).map(({ entry, limit: item }) => [
      entry.scope.agentBackendId,
      remainingPercent(item),
    ])).toEqual([["codex", 18], ["grok", 65]])
    expect(sortQuotaEntries([claude, grok, codex]).map((entry) => entry.scope.agentBackendId))
      .toEqual(["codex", "grok", "claude"])
  })

  it("rounds remaining percentages half-up to at most one decimal place without trailing .0", () => {
    expect(remainingPercent(limit({ usedPercent: 8.102625608444 }))).toBe(91.9)
    expect(remainingPercent(limit({ usedPercent: 28.828197717667 }))).toBe(71.2)
    expect(remainingPercent(limit({ usedPercent: 30.5 }))).toBe(69.5)
    expect(remainingPercent(limit({ usedPercent: 64.15 }))).toBe(35.9)
    expect(remainingPercent(limit({ usedPercent: 30.04 }))).toBe(70)
    expect(remainingPercent(limit({ usedPercent: 0 }))).toBe(100)
    expect(remainingPercent(limit({ usedPercent: 100 }))).toBe(0)
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
    const grok = quotaEntry([limit({
      limitId: "grok-primary",
      productId: "grok",
      productName: "Grok",
      modelId: "grok-4.6",
      usedPercent: 35,
    })], "available", "grok")
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
    const renderer = render([pi, codex, claude, grok])
    const trigger = renderer.getByTestId("community-machine-quota-m1")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    expect(text(trigger)).toBe("Quota·Codex (automatic)18%·65%")
    expect(trigger).toHaveAttribute(
      "aria-label",
      expect.stringContaining("Codex (automatic) 18% left; Grok 65% left"),
    )
    expect([...trigger.querySelectorAll<HTMLElement>("[data-provider-logo]")]
      .map((node) => node.dataset.providerLogo))
      .toEqual(["codex", "grok"])

    fireEvent.click(trigger)
    expect(renderer.getByTestId("community-machine-quota-m1")).toHaveAttribute("aria-expanded", "true")
    const detail = renderer.getByTestId("community-machine-quota-detail-m1")
    expect(text(detail)).toContain("Machine quota")
    expect(text(detail)).toContain("Claude")
    expect(text(detail)).toContain("Codex")
    expect(text(detail)).toContain("Grok")
    expect(text(detail)).toContain("Pi")
    expect(text(detail)).toContain("Pending")
    expect(text(detail)).toContain("Not supported")
    expect(text(detail)).toContain("5 hour usage limit")
    expect(text(detail)).toContain("Weekly usage limit")
    expect(text(detail)).toContain("18% left")
    expect(text(detail)).toContain("44.5% left")
    expect(text(detail)).toContain("2m ago")
    expect([...detail.querySelectorAll<HTMLElement>("[data-provider-logo]")]
      .map((node) => node.dataset.providerLogo))
      .toEqual(["codex", "grok", "claude", "pi"])
    expect([...detail.querySelectorAll<HTMLElement>("[data-quota-backend]")]
      .map((node) => node.dataset.quotaBackend))
      .toEqual(["codex", "grok", "claude", "pi"])
  })

  it("shows one limit's server-authored window and stale state", () => {
    const renderer = render([quotaEntry([limit({ usedPercent: 37.5 })], "stale")])
    const trigger = renderer.getByTestId("community-machine-quota-m1")
    expect(text(trigger)).toBe("Quota·Codex (automatic)62.5%stale")
    expect(trigger).toHaveAttribute("aria-label", expect.stringContaining("Codex (automatic) 62.5% left, stale"))
  })

  it("formats multi-decimal provider telemetry to at most one decimal place in summary and popover", () => {
    const agyWeekly = limit({
      limitId: "agy-weekly",
      productId: "antigravity",
      productName: "Antigravity",
      window: { kind: "provider_defined", id: "weekly", displayName: "Weekly Limit Remaining" },
      usedPercent: 8.102625608444,
    })
    const agyFiveHour = limit({
      limitId: "agy-five-hour",
      productId: "antigravity",
      productName: "Antigravity",
      window: { kind: "provider_defined", id: "five_hour", displayName: "Five Hour Limit Remaining" },
      usedPercent: 28.828197717667,
    })
    const agyFull = limit({
      limitId: "agy-secondary",
      productId: "antigravity",
      productName: "Antigravity",
      window: { kind: "provider_defined", id: "weekly-2", displayName: "Weekly Limit Remaining" },
      usedPercent: 0,
    })
    const renderer = render([quotaEntry([agyWeekly, agyFiveHour, agyFull], "available", "agy")])
    const trigger = renderer.getByTestId("community-machine-quota-m1")
    expect(text(trigger)).toBe("Quota·71.2%")
    expect(trigger).toHaveAttribute("aria-label", "Quota details: Agy 71.2% left. 3 limits")
    fireEvent.click(trigger)
    const detail = renderer.getByTestId("community-machine-quota-detail-m1")
    expect(text(detail)).toContain("91.9% left")
    expect(text(detail)).toContain("71.2% left")
    expect(text(detail)).toContain("100% left")
    expect(text(detail)).not.toContain("91.897")
    expect(text(detail)).not.toContain("71.171")
  })

  it("exposes unavailable backend details alongside pending peers without inventing limits", () => {
    const pending = { ...quotaEntry([]), snapshot: { status: "pending" as const } }
    const unavailable = {
      ...quotaEntry([], "available", "antigravity"),
      snapshot: { status: "error" as const, code: "unavailable" as const },
    }
    const renderer = render([pending, unavailable])
    const trigger = renderer.getByTestId("community-machine-quota-m1")
    expect(text(trigger)).toBe("Codex (automatic)Quota pending")
    expect(trigger).toHaveAttribute("aria-expanded", "false")
    fireEvent.click(trigger)
    const detail = renderer.getByTestId("community-machine-quota-detail-m1")
    expect(text(detail.querySelector('[data-quota-backend="antigravity"]')!)).toBe("AntigravityUnavailable")
    expect(text(detail.querySelector('[data-quota-backend="codex"]')!)).toBe("Codex (automatic)Pending")
    expect(text(detail)).not.toMatch(/%|Resets|Updated/)
  })

  it("keeps an available backend with no reported limits visible in details", () => {
    const renderer = render([quotaEntry([], "available", "antigravity")])
    fireEvent.click(renderer.getByTestId("community-machine-quota-m1"))
    const detail = renderer.getByTestId("community-machine-quota-detail-m1")
    expect(text(detail)).toContain("Antigravity")
    expect(text(detail)).toContain("Unavailable")
    expect(text(detail)).not.toContain("%")
  })

  it("renders honest fixed-height placeholders for missing capability states", () => {
    expect(text(render().container)).toContain("Quota unavailable")
    const unsupported = render([{
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "pi" },
      capability: "unsupported",
      runtimeState: "healthy",
      snapshot: { status: "pending" },
    }])
    expect(text(unsupported.container)).toContain("Quota not supported")
    expect(unsupported.container.querySelector("[data-provider-logo]")).toHaveAttribute(
      "data-provider-logo",
      "pi",
    )
    expect(text(render([{
      scope: { kind: "machine_backend", machineId: "m1", agentBackendId: "codex" },
      capability: "supported",
      runtimeState: "offline",
      snapshot: { status: "pending" },
    }]).container)).toContain("Quota pending")
  })
})

it("shows explicit Codex sources in the summary while retaining legacy details", () => {
  const renderer = render([
    quotaEntry([limit({ usedPercent: 20 })], "available", "codex"),
    quotaEntry([limit({ usedPercent: 20 })], "available", "codex-app"),
    quotaEntry([limit({ usedPercent: 70 })], "available", "codex-cli"),
  ])
  const trigger = renderer.getByTestId("community-machine-quota-m1")
  expect(trigger).toHaveAttribute("aria-label", expect.stringContaining("Codex App 80% left"))
  expect(trigger).toHaveAttribute("aria-label", expect.stringContaining("Codex CLI 30% left"))
  expect(text(trigger)).not.toContain("Codex (automatic)")
  expect(text(trigger)).toContain("Codex App80%")
  expect(text(trigger)).toContain("Codex CLI30%")
  fireEvent.click(trigger)
  const detail = renderer.getByTestId("community-machine-quota-detail-m1")
  expect(text(detail.querySelector('[data-quota-backend="codex"]')!)).toContain("Codex (automatic)")
  expect(text(detail.querySelector('[data-quota-backend="codex-app"]')!)).toContain("Codex App")
  expect(text(detail.querySelector('[data-quota-backend="codex-cli"]')!)).toContain("Codex CLI")
})

it("does not use legacy quota for pending or unavailable explicit Codex sources", () => {
  const renderer = render([
    quotaEntry([limit({ usedPercent: 20 })], "available", "codex"),
    { ...quotaEntry([], "available", "codex-app"), snapshot: { status: "pending" } },
    { ...quotaEntry([], "available", "codex-cli"), snapshot: { status: "error", code: "unavailable" } },
  ])
  const trigger = renderer.getByTestId("community-machine-quota-m1")
  expect(text(trigger)).toContain("Codex App")
  expect(text(trigger)).toContain("Codex CLI")
  expect(text(trigger)).toContain("Quota pending")
  expect(trigger).toHaveAttribute("aria-label", "Quota details: Codex App, Codex CLI. Quota pending")
  expect(text(trigger)).not.toContain("%")
  expect(text(trigger)).not.toContain("Codex (automatic)")
  fireEvent.click(trigger)
  const detail = renderer.getByTestId("community-machine-quota-detail-m1")
  expect(text(detail.querySelector('[data-quota-backend="codex"]')!)).toContain("80% left")
  expect(text(detail.querySelector('[data-quota-backend="codex-app"]')!)).toContain("Pending")
  expect(text(detail.querySelector('[data-quota-backend="codex-cli"]')!)).toContain("Unavailable")
})
