import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { render, setupUser } from "@/test/react-dom-harness"
import type {
  ScheduleActor,
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
          channelLabel: "/Alook#5620/gus-board#42",
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
  onOpenSourceMessage = vi.fn(),
  onAskBot = vi.fn(),
  onOpenBots = vi.fn(),
}: {
  initialView?: ScheduleViewMode
  bots?: readonly ScheduleActor[]
  onOpenSourceMessage?: (messageId: string) => void
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
      onOpenSourceMessage={onOpenSourceMessage}
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

  it("displays read-only task detail and clickable message-ref pills without edit or delete actions", async () => {
    const user = setupUser()
    const onOpenSourceMessage = vi.fn()
    const view = render(<Harness initialView="agenda" onOpenSourceMessage={onOpenSourceMessage} />)

    const agendaRow = view.getByTestId(tid.scheduleEvent("sch_1"))
    const agendaPill = agendaRow.querySelector("button")
    expect(agendaPill).not.toBeNull()
    await user.click(agendaPill!)
    expect(onOpenSourceMessage).toHaveBeenCalledWith("msg_standup")
    expect(view.queryByTestId(tid.scheduleDetailSheet)).toBeNull()

    onOpenSourceMessage.mockClear()
    await user.click(view.getByTestId(tid.scheduleEvent("sch_1")))
    expect(view.getByTestId(tid.scheduleDetailSheet)).toBeInTheDocument()
    expect(view.getByText("Scheduled by")).toBeInTheDocument()
    expect(view.queryByRole("button", { name: "Edit event" })).toBeNull()
    expect(view.queryByRole("button", { name: "Delete event" })).toBeNull()
    expect(view.queryByRole("button", { name: "Open original message" })).toBeNull()
    expect(view.getAllByText("Dispatched").length).toBeGreaterThan(0)
    const detailPill = view.getByTestId(tid.scheduleSourceLink)
    expect(detailPill).toHaveTextContent("Alook /")
    expect(detailPill).toHaveTextContent("gus-board")
    expect(detailPill).toHaveTextContent("#42")
    await user.click(detailPill)
    expect(onOpenSourceMessage).toHaveBeenCalledWith("msg_standup")

    await user.click(view.getByTestId(tid.scheduleEvent("sch_2")))
    expect(view.getByText("Original message is unavailable")).toBeInTheDocument()
    expect(view.getAllByText("Access blocked").length).toBeGreaterThan(0)
    expect(view.queryByTestId(tid.scheduleSourceLink)).toBeNull()
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
        onOpenSourceMessage={vi.fn()}
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
})
