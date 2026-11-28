import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { act, fireEvent, mockElementGeometry, render, setupUser } from "@/test/react-dom-harness"
import type {
  ScheduleActor,
  ScheduleBoundMessageState,
  ScheduleOccurrenceItem,
  ScheduleViewMode,
} from "./schedule-types"
import { ScheduleWorkspace } from "./schedule-workspace"

const ANCHOR = new Date(2026, 10, 25)

const ALLI: ScheduleActor = { id: "bot_alli", name: "Alli", handle: "@Alli#6011", kind: "bot" }
const ELWIRA: ScheduleActor = { id: "bot_elwira", name: "Elwira", handle: "@Elwira#8700", kind: "bot" }

function makeFixtureOccurrences(): ScheduleOccurrenceItem[] {
  const start1 = new Date(2026, 10, 25, 9, 30).toISOString()
  const end1 = new Date(2026, 10, 25, 10, 0).toISOString()
  const start2 = new Date(2026, 10, 26, 14, 0).toISOString()
  const end2 = new Date(2026, 10, 26, 14, 45).toISOString()
  return [
    {
      occurrenceKey: `sch_1:${start1}`,
      eventId: "sch_1",
      startAt: start1,
      endAt: end1,
      runStatus: "dispatched",
      event: {
        id: "sch_1",
        title: "Daily standup summary",
        description: "Summarize team progress in the thread.",
        creator: ALLI,
        startAt: start1,
        durationMinutes: 30,
        endAt: end1,
        timeZone: "Asia/Shanghai",
        recurrence: {
          recurring: true,
          label: "Daily",
          rule: { freq: "daily", interval: 1 },
          nextRunAt: start2,
        },
        sourceMessage: {
          messageId: "msg_standup",
          accessible: true,
          channelLabel: "/.dm/Alli#6011#14",
          excerpt: "Please send a daily standup digest here.",
        },
        lastExecution: { status: "dispatched", scheduledAt: start1, updatedAt: start1 },
      },
    },
    {
      occurrenceKey: `sch_2:${start2}`,
      eventId: "sch_2",
      startAt: start2,
      endAt: end2,
      runStatus: "blocked_access",
      event: {
        id: "sch_2",
        title: "Archived thread reminder",
        creator: ELWIRA,
        startAt: start2,
        durationMinutes: 45,
        endAt: end2,
        timeZone: "Asia/Shanghai",
        recurrence: { recurring: false, label: "One-time" },
        sourceMessage: {
          messageId: "msg_lost",
          accessible: false,
        },
        lastExecution: {
          status: "blocked_access",
          scheduledAt: start2,
          lastError: "Creator bot lost access to the bound message.",
        },
      },
    },
  ]
}

function Harness({
  initialView = "agenda",
  bots = [ALLI, ELWIRA],
  boundMessage,
  onAskBot = vi.fn(),
  onOpenBots = vi.fn(),
}: {
  initialView?: ScheduleViewMode
  bots?: readonly ScheduleActor[]
  boundMessage?: ScheduleBoundMessageState
  onAskBot?: (botId: string) => void
  onOpenBots?: () => void
}) {
  const [view, setView] = useState<ScheduleViewMode>(initialView)
  const [anchorDate, setAnchorDate] = useState<Date>(ANCHOR)
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  return (
    <ScheduleWorkspace
      view={view}
      onViewChange={setView}
      anchorDate={anchorDate}
      onAnchorDateChange={setAnchorDate}
      selectedBotId={selectedBotId}
      onSelectedBotIdChange={setSelectedBotId}
      bots={bots}
      occurrences={makeFixtureOccurrences()}
      boundMessage={boundMessage}
      onAskBot={onAskBot}
      onOpenBots={onOpenBots}
    />
  )
}

describe("ScheduleWorkspace", () => {
  it("switches between Week and Agenda views without offering Month", async () => {
    const user = setupUser()
    const view = render(<Harness initialView="week" />)
    expect(view.getByTestId(tid.scheduleWeekGrid)).toBeInTheDocument()
    expect(view.queryByRole("tab", { name: "Month" })).toBeNull()

    await user.click(view.getByRole("tab", { name: "Agenda" }))
    expect(view.getByTestId(tid.scheduleAgenda)).toBeInTheDocument()
    expect(view.getByText("Daily standup summary")).toBeInTheDocument()
  })

  it("renders read-only task detail with inline bound message and non-navigating ref pill", async () => {
    const user = setupUser()
    const boundMessage: ScheduleBoundMessageState = {
      status: "ready",
      message: {
        id: "msg_standup",
        authorId: "user_gus",
        authorName: "Gus",
        authorAvatar: "G",
        createdAt: new Date(2026, 10, 24, 21, 15).toISOString(),
        content: "Every morning at 9:30, post a concise standup digest here.",
      },
    }
    const view = render(<Harness initialView="agenda" boundMessage={boundMessage} />)

    const agendaRow = view.getByTestId(tid.scheduleEvent("sch_1"))
    expect(agendaRow.querySelector("button")).toBeNull()
    await user.click(agendaRow)

    const sheet = view.getByTestId(tid.scheduleDetailSheet)
    expect(sheet).toBeInTheDocument()
    expect(view.getByText("Scheduled by")).toBeInTheDocument()
    expect(view.queryByRole("button", { name: "Edit event" })).toBeNull()
    expect(view.queryByRole("button", { name: "Delete event" })).toBeNull()
    expect(view.queryByRole("button", { name: "Open original message" })).toBeNull()
    expect(view.getAllByText("Dispatched").length).toBeGreaterThan(0)

    const detailPill = view.getByTestId(tid.scheduleSourceLink)
    expect(detailPill.tagName).toBe("SPAN")
    expect(detailPill).toHaveTextContent("DM /")
    expect(detailPill).toHaveTextContent("@Alli")
    expect(detailPill).toHaveTextContent("#14")
    await user.click(detailPill)
    expect(view.getByTestId(tid.scheduleDetailSheet)).toBeInTheDocument()

    expect(view.getByText("Gus")).toBeInTheDocument()
    expect(view.getByText("Every morning at 9:30, post a concise standup digest here.")).toBeInTheDocument()

    await user.click(view.getByTestId(tid.scheduleEvent("sch_2")))
    expect(view.getByText("Original message is unavailable")).toBeInTheDocument()
    expect(view.getAllByText("Access blocked").length).toBeGreaterThan(0)
    expect(view.queryByTestId(tid.scheduleSourceLink)).toBeNull()
  })

  it("renders inline bound message loading shimmer and retryable error fallback", async () => {
    const user = setupUser()
    const onRetry = vi.fn()
    const loadingView = render(
      <Harness
        initialView="agenda"
        boundMessage={{ status: "loading", message: null }}
      />,
    )
    await user.click(loadingView.getByTestId(tid.scheduleEvent("sch_1")))
    expect(loadingView.getByRole("status", { name: "Loading bound message" })).toBeInTheDocument()
    loadingView.unmount()

    const errorView = render(
      <Harness
        initialView="agenda"
        boundMessage={{ status: "error", message: null, onRetry }}
      />,
    )
    await user.click(errorView.getByTestId(tid.scheduleEvent("sch_1")))
    expect(errorView.getByText("Please send a daily standup digest here.")).toBeInTheDocument()
    await user.click(errorView.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledOnce()
  })

  it("renders completed execution state and acknowledged timestamp from --ack", async () => {
    const user = setupUser()
    const ackedAt = new Date(2026, 10, 25, 9, 34).toISOString()
    const completedOccurrence: ScheduleOccurrenceItem = {
      ...makeFixtureOccurrences()[0]!,
      runStatus: "completed",
      event: {
        ...makeFixtureOccurrences()[0]!.event,
        lastExecution: {
          status: "completed",
          scheduledAt: makeFixtureOccurrences()[0]!.startAt,
          ackedAt,
          updatedAt: ackedAt,
        },
      },
    }
    const view = render(
      <ScheduleWorkspace
        view="agenda"
        onViewChange={vi.fn()}
        anchorDate={ANCHOR}
        onAnchorDateChange={vi.fn()}
        selectedBotId={null}
        onSelectedBotIdChange={vi.fn()}
        bots={[ALLI]}
        occurrences={[completedOccurrence]}
      />,
    )
    expect(view.getByText("Completed")).toBeInTheDocument()
    await user.click(view.getByTestId(tid.scheduleEvent("sch_1")))
    expect(view.getByText(/Acknowledged by bot/i)).toBeInTheDocument()
  })

  it("prompts users to ask a bot to schedule, supports single/multi-bot jump, and guides to My Bots when empty", async () => {
    const user = setupUser()
    const onAskBot = vi.fn()
    const multi = render(<Harness initialView="week" bots={[ALLI, ELWIRA]} onAskBot={onAskBot} />)
    await user.click(multi.getByTestId(tid.scheduleAskBot))
    await user.click(multi.getByRole("button", { name: "Elwira" }))
    expect(onAskBot).toHaveBeenCalledWith("bot_elwira")
    multi.unmount()

    const onAskSingle = vi.fn()
    const single = render(<Harness initialView="week" bots={[ALLI]} onAskBot={onAskSingle} />)
    await user.click(single.getByTestId(tid.scheduleAskBot))
    expect(onAskSingle).toHaveBeenCalledWith("bot_alli")
    single.unmount()

    const onOpenBots = vi.fn()
    const empty = render(<Harness initialView="week" bots={[]} onOpenBots={onOpenBots} />)
    await user.click(empty.getByTestId(tid.scheduleAskBot))
    expect(onOpenBots).toHaveBeenCalledOnce()
  })

  it("keeps the workspace and grid mounted with inline shimmer skeleton while refreshing a new date range", () => {
    const view = render(
      <ScheduleWorkspace
        view="week"
        onViewChange={vi.fn()}
        anchorDate={ANCHOR}
        onAnchorDateChange={vi.fn()}
        selectedBotId={null}
        onSelectedBotIdChange={vi.fn()}
        bots={[ALLI]}
        occurrences={makeFixtureOccurrences()}
        refreshing
      />,
    )

    const page = view.getByTestId(tid.schedulePage)
    expect(page).toHaveAttribute("data-schedule-refreshing", "true")
    expect(view.getByTestId(tid.scheduleWeekGrid)).toBeInTheDocument()
    expect(view.getByRole("progressbar", { name: "Loading schedule range" })).toBeInTheDocument()
    expect(page.querySelector('[data-schedule-inline-skeleton="week"]')).not.toBeNull()

    view.rerender(
      <ScheduleWorkspace
        view="agenda"
        onViewChange={vi.fn()}
        anchorDate={ANCHOR}
        onAnchorDateChange={vi.fn()}
        selectedBotId={null}
        onSelectedBotIdChange={vi.fn()}
        bots={[ALLI]}
        occurrences={makeFixtureOccurrences()}
        refreshing
      />,
    )

    expect(view.getByTestId(tid.scheduleAgenda)).toBeInTheDocument()
    expect(view.getByTestId(tid.schedulePage).querySelector('[data-schedule-inline-skeleton="agenda"]')).not.toBeNull()
  })

  it("supports mobile left/right swipe to switch next/previous day, ignores vertical drag, and suppresses click after swipe", () => {
    vi.useFakeTimers()
    try {
      const view = render(<Harness initialView="week" />)
      const surface = view.getByTestId(tid.scheduleWeekGrid).querySelector<HTMLElement>('[data-schedule-swipe-surface="true"]')!
      expect(surface).not.toBeNull()
      const restoreGeometry = mockElementGeometry(surface, { width: 390, height: 500, clientWidth: 390, clientHeight: 500 })

      const dayStrip = view.getByRole("tablist", { name: "Days of week" })
      const selectedTabDate = () => {
        const selected = dayStrip.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        return selected?.textContent ?? ""
      }
      expect(selectedTabDate()).toContain("25")

      const pointer = (type: "pointerDown" | "pointerMove" | "pointerUp", clientX: number, clientY: number) => {
        fireEvent[type](surface, {
          pointerId: 1,
          pointerType: "touch",
          isPrimary: true,
          clientX,
          clientY,
        })
      }

      pointer("pointerDown", 240, 180)
      pointer("pointerMove", 130, 184)
      pointer("pointerUp", 130, 184)
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(selectedTabDate()).toContain("26")

      pointer("pointerDown", 140, 180)
      pointer("pointerMove", 250, 182)
      pointer("pointerUp", 250, 182)
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(selectedTabDate()).toContain("25")

      pointer("pointerDown", 200, 180)
      pointer("pointerMove", 206, 260)
      pointer("pointerUp", 206, 260)
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(selectedTabDate()).toContain("25")

      const card = surface.querySelector<HTMLElement>(`[data-testid="${tid.scheduleEvent("sch_1")}"]`)!
      expect(card).not.toBeNull()
      fireEvent.pointerDown(card, { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: 240, clientY: 160 })
      fireEvent.pointerMove(card, { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: 150, clientY: 162 })
      fireEvent.pointerUp(card, { pointerId: 2, pointerType: "touch", isPrimary: true, clientX: 150, clientY: 162 })
      fireEvent.click(card)
      expect(view.queryByTestId(tid.scheduleDetailSheet)).toBeNull()
      act(() => {
        vi.advanceTimersByTime(250)
      })
      expect(selectedTabDate()).toContain("26")

      restoreGeometry()
    } finally {
      vi.useRealTimers()
    }
  })

  it("renders concrete month/day/year titles in Agenda for dates past Tomorrow", () => {
    const view = render(<Harness initialView="agenda" />)
    const agenda = view.getByTestId(tid.scheduleAgenda)
    const headings = Array.from(agenda.querySelectorAll("h2")).map((node) => node.textContent ?? "")
    expect(headings.length).toBeGreaterThan(0)
    expect(headings.every((title) => title.includes("2026"))).toBe(true)
  })
})
