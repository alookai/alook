import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { tid } from "@/lib/community/testids"
import { render, setupUser } from "@/test/react-dom-harness"
import type {
  CalendarActor,
  CalendarEventEditDraft,
  CalendarEventItem,
  CalendarOccurrenceItem,
  CalendarViewMode,
} from "./calendar-types"
import { CalendarWorkspace } from "./calendar-workspace"

const ANCHOR = new Date(2026, 10, 25)

const ALLI: CalendarActor = { id: "bot_alli", name: "Alli", handle: "@Alli#6011", kind: "bot" }
const ELWIRA: CalendarActor = { id: "bot_elwira", name: "Elwira", handle: "@Elwira#8700", kind: "bot" }

function makeFixtureOccurrences(): CalendarOccurrenceItem[] {
  const start1 = new Date(2026, 10, 25, 9, 30).toISOString()
  const end1 = new Date(2026, 10, 25, 10, 0).toISOString()
  const start2 = new Date(2026, 10, 26, 14, 0).toISOString()
  const end2 = new Date(2026, 10, 26, 14, 45).toISOString()
  return [
    {
      occurrenceKey: `cal_1:${start1}`,
      eventId: "cal_1",
      startAt: start1,
      endAt: end1,
      runStatus: "dispatched",
      event: {
        id: "cal_1",
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
          channelLabel: "/Alook#5620/gus-board",
          excerpt: "Please send a daily standup digest here.",
        },
        lastExecution: { status: "dispatched", scheduledAt: start1, updatedAt: start1 },
      },
    },
    {
      occurrenceKey: `cal_2:${start2}`,
      eventId: "cal_2",
      startAt: start2,
      endAt: end2,
      runStatus: "blocked_access",
      event: {
        id: "cal_2",
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

const PAUSED_EVENT: CalendarEventItem = {
  id: "cal_paused",
  title: "Weekly retro",
  creator: ALLI,
  startAt: new Date(2026, 10, 27, 16, 0).toISOString(),
  durationMinutes: 30,
  timeZone: "Asia/Shanghai",
  recurrence: { recurring: true, label: "Weekly · Fri", rule: { freq: "weekly", interval: 1, byWeekday: [5] } },
  sourceMessage: { messageId: "msg_retro", accessible: true },
  paused: true,
}

function Harness({
  initialView = "agenda",
  pausedEvents = [],
  onOpenSourceMessage = vi.fn(),
  onSaveEvent = vi.fn(),
  onDeleteEvent = vi.fn(),
}: {
  initialView?: CalendarViewMode
  pausedEvents?: readonly CalendarEventItem[]
  onOpenSourceMessage?: (messageId: string) => void
  onSaveEvent?: (eventId: string, draft: CalendarEventEditDraft) => void
  onDeleteEvent?: (eventId: string) => void
}) {
  const [view, setView] = useState<CalendarViewMode>(initialView)
  const [anchorDate, setAnchorDate] = useState<Date>(ANCHOR)
  const [selectedCreatorId, setSelectedCreatorId] = useState<string | null>(null)
  return (
    <CalendarWorkspace
      view={view}
      onViewChange={setView}
      anchorDate={anchorDate}
      onAnchorDateChange={setAnchorDate}
      selectedCreatorId={selectedCreatorId}
      onSelectedCreatorIdChange={setSelectedCreatorId}
      creators={[ALLI, ELWIRA]}
      occurrences={makeFixtureOccurrences()}
      pausedEvents={pausedEvents}
      onOpenSourceMessage={onOpenSourceMessage}
      onSaveEvent={onSaveEvent}
      onDeleteEvent={onDeleteEvent}
    />
  )
}

describe("CalendarWorkspace", () => {
  it("switches between Week and Agenda views without offering Month", async () => {
    const user = setupUser()
    const view = render(<Harness initialView="week" />)
    expect(view.getByTestId(tid.calendarWeekGrid)).toBeInTheDocument()
    expect(view.queryByRole("tab", { name: "Month" })).toBeNull()

    await user.click(view.getByRole("tab", { name: "Agenda" }))
    expect(view.getByTestId(tid.calendarAgenda)).toBeInTheDocument()
    expect(view.getByText("Daily standup summary")).toBeInTheDocument()
  })

  it("displays creator, 3-state execution status, and source-message states without a participants section", async () => {
    const user = setupUser()
    const onOpenSourceMessage = vi.fn()
    const view = render(<Harness initialView="agenda" onOpenSourceMessage={onOpenSourceMessage} />)

    await user.click(view.getByTestId(tid.calendarEvent("cal_1")))
    expect(view.getByTestId(tid.calendarDetailSheet)).toBeInTheDocument()
    expect(view.getByText("Creator")).toBeInTheDocument()
    expect(view.queryByText(/Participants/i)).toBeNull()
    expect(view.getAllByText("Dispatched").length).toBeGreaterThan(0)
    await user.click(view.getByTestId(tid.calendarSourceLink))
    expect(onOpenSourceMessage).toHaveBeenCalledWith("msg_standup")

    await user.click(view.getByTestId(tid.calendarEvent("cal_2")))
    expect(view.getByText("Original message is unavailable")).toBeInTheDocument()
    expect(view.getAllByText("Access blocked").length).toBeGreaterThan(0)
    expect(view.queryByTestId(tid.calendarSourceLink)).toBeNull()
  })

  it("keeps paused schedules reachable for resuming or editing", async () => {
    const user = setupUser()
    const view = render(<Harness initialView="agenda" pausedEvents={[PAUSED_EVENT]} />)
    expect(view.getByText("Paused schedules (1)")).toBeInTheDocument()
    await user.click(view.getByTestId(tid.calendarEvent("cal_paused")))
    expect(view.getByTestId(tid.calendarDetailSheet)).toBeInTheDocument()
    expect(view.getAllByText("Weekly retro").length).toBeGreaterThan(0)
  })

  it("supports editing and confirming deletion from the detail sheet", async () => {
    const user = setupUser()
    const onSaveEvent = vi.fn()
    const onDeleteEvent = vi.fn()
    const view = render(
      <Harness
        initialView="agenda"
        onSaveEvent={onSaveEvent}
        onDeleteEvent={onDeleteEvent}
      />,
    )

    await user.click(view.getByTestId(tid.calendarEvent("cal_1")))
    await user.click(view.getByRole("button", { name: "Edit event" }))
    const titleInput = view.getByLabelText("Title")
    await user.clear(titleInput)
    await user.type(titleInput, "Updated standup")
    await user.click(view.getByRole("button", { name: "Save changes" }))
    expect(onSaveEvent).toHaveBeenCalledWith(
      "cal_1",
      expect.objectContaining({
        title: "Updated standup",
      }),
    )

    await user.click(view.getByRole("button", { name: "Delete event" }))
    const confirmButtons = view.getAllByRole("button", { name: "Delete event" })
    await user.click(confirmButtons[confirmButtons.length - 1]!)
    expect(onDeleteEvent).toHaveBeenCalledWith("cal_1")
  })
})
