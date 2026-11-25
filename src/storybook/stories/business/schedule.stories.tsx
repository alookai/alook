import { useState } from "react"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { SchedulePageSkeleton } from "@/components/community/schedule/schedule-skeleton"
import type {
  ScheduleActor,
  ScheduleOccurrenceItem,
  ScheduleViewMode,
} from "@/components/community/schedule/schedule-types"
import { ScheduleWorkspace } from "@/components/community/schedule/schedule-workspace"

const ANCHOR = new Date(2026, 10, 25)
const ALLI: ScheduleActor = { id: "bot_alli", name: "Alli", handle: "@Alli#6011", kind: "bot" }
const ELWIRA: ScheduleActor = { id: "bot_elwira", name: "Elwira", handle: "@Elwira#8700", kind: "bot" }
const CECILIA: ScheduleActor = { id: "bot_cecilia", name: "Cecilia", handle: "@Cecilia#7971", kind: "bot" }

const SAMPLE_OCCURRENCES: ScheduleOccurrenceItem[] = [
  {
    occurrenceKey: "sch_1:2026-11-24T09:30",
    eventId: "sch_1",
    startAt: new Date(2026, 10, 24, 9, 30).toISOString(),
    endAt: new Date(2026, 10, 24, 10, 0).toISOString(),
    runStatus: "completed",
    event: {
      id: "sch_1",
      title: "Daily standup summary",
      description: "Summarize completed work and open blockers in the thread.",
      creator: ALLI,
      startAt: new Date(2026, 10, 24, 9, 30).toISOString(),
      durationMinutes: 30,
      endAt: new Date(2026, 10, 24, 10, 0).toISOString(),
      timeZone: "Asia/Shanghai",
      recurrence: {
        recurring: true,
        label: "Daily",
        rule: { freq: "daily", interval: 1 },
        nextRunAt: new Date(2026, 10, 25, 9, 30).toISOString(),
      },
      sourceMessage: {
        messageId: "msg_standup",
        accessible: true,
        status: "accessible",
        channelLabel: "/Alook#5620/gus-board#42",
        excerpt: "Please send a daily standup digest here.",
      },
      lastExecution: {
        status: "completed",
        scheduledAt: new Date(2026, 10, 24, 9, 30).toISOString(),
        ackedAt: new Date(2026, 10, 24, 9, 34).toISOString(),
        updatedAt: new Date(2026, 10, 24, 9, 34).toISOString(),
      },
    },
  },
  {
    occurrenceKey: "sch_1:2026-11-25T09:30",
    eventId: "sch_1",
    startAt: new Date(2026, 10, 25, 9, 30).toISOString(),
    endAt: new Date(2026, 10, 25, 10, 0).toISOString(),
    runStatus: "dispatched",
    event: {
      id: "sch_1",
      title: "Daily standup summary",
      description: "Summarize completed work and open blockers in the thread.",
      creator: ALLI,
      startAt: new Date(2026, 10, 25, 9, 30).toISOString(),
      durationMinutes: 30,
      endAt: new Date(2026, 10, 25, 10, 0).toISOString(),
      timeZone: "Asia/Shanghai",
      recurrence: {
        recurring: true,
        label: "Daily",
        rule: { freq: "daily", interval: 1 },
        nextRunAt: new Date(2026, 10, 26, 9, 30).toISOString(),
      },
      sourceMessage: {
        messageId: "msg_standup",
        accessible: true,
        status: "accessible",
        channelLabel: "/Alook#5620/gus-board#42",
        excerpt: "Please send a daily standup digest here.",
      },
      lastExecution: {
        status: "dispatched",
        scheduledAt: new Date(2026, 10, 25, 9, 30).toISOString(),
        updatedAt: new Date(2026, 10, 25, 9, 30).toISOString(),
      },
    },
  },
  {
    occurrenceKey: "sch_3:2026-11-25T11:00",
    eventId: "sch_3",
    startAt: new Date(2026, 10, 25, 11, 0).toISOString(),
    endAt: new Date(2026, 10, 25, 12, 30).toISOString(),
    runStatus: "scheduled",
    event: {
      id: "sch_3",
      title: "Design review prep",
      description: "Collect desktop and mobile shell screenshots before the review.",
      creator: CECILIA,
      startAt: new Date(2026, 10, 25, 11, 0).toISOString(),
      durationMinutes: 90,
      endAt: new Date(2026, 10, 25, 12, 30).toISOString(),
      timeZone: "Asia/Shanghai",
      recurrence: { recurring: false, label: "One-time" },
      sourceMessage: {
        messageId: "msg_design",
        accessible: true,
        status: "accessible",
        channelLabel: "/Alook#5620/gus-uiux#3880",
        excerpt: "Bring light and dark captures for both viewports.",
      },
    },
  },
  {
    occurrenceKey: "sch_4:2026-11-25T15:00",
    eventId: "sch_4",
    startAt: new Date(2026, 10, 25, 15, 0).toISOString(),
    endAt: new Date(2026, 10, 25, 15, 30).toISOString(),
    runStatus: "pending",
    event: {
      id: "sch_4",
      title: "Release gate check",
      description: "Verify CI status and confirm merge sign-off with Gus.",
      creator: ELWIRA,
      startAt: new Date(2026, 10, 25, 15, 0).toISOString(),
      durationMinutes: 30,
      endAt: new Date(2026, 10, 25, 15, 30).toISOString(),
      timeZone: "Asia/Shanghai",
      recurrence: { recurring: false, label: "One-time" },
      sourceMessage: {
        messageId: "msg_gate",
        accessible: true,
        status: "accessible",
        channelLabel: "/Alook#5620/gus-issues/#305",
      },
      lastExecution: {
        status: "pending",
        scheduledAt: new Date(2026, 10, 25, 15, 0).toISOString(),
      },
    },
  },
  {
    occurrenceKey: "sch_2:2026-11-26T14:00",
    eventId: "sch_2",
    startAt: new Date(2026, 10, 26, 14, 0).toISOString(),
    endAt: new Date(2026, 10, 26, 15, 0).toISOString(),
    runStatus: "blocked_access",
    event: {
      id: "sch_2",
      title: "Archived thread reminder",
      creator: ELWIRA,
      startAt: new Date(2026, 10, 26, 14, 0).toISOString(),
      durationMinutes: 60,
      endAt: new Date(2026, 10, 26, 15, 0).toISOString(),
      timeZone: "Asia/Shanghai",
      recurrence: { recurring: false, label: "One-time" },
      sourceMessage: {
        messageId: "msg_lost",
        accessible: false,
        status: "inaccessible",
      },
      lastExecution: {
        status: "blocked_access",
        scheduledAt: new Date(2026, 10, 26, 14, 0).toISOString(),
        lastError: "Creator bot lost access to the bound message.",
      },
    },
  },
]

function ScheduleSpecimen({ initialView }: { initialView: ScheduleViewMode }) {
  const [view, setView] = useState<ScheduleViewMode>(initialView)
  const [anchorDate, setAnchorDate] = useState<Date>(ANCHOR)
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null)
  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      <ScheduleWorkspace
        view={view}
        onViewChange={setView}
        anchorDate={anchorDate}
        onAnchorDateChange={setAnchorDate}
        selectedBotId={selectedBotId}
        onSelectedBotIdChange={setSelectedBotId}
        bots={[ALLI, ELWIRA, CECILIA]}
        occurrences={SAMPLE_OCCURRENCES}
        onBack={() => undefined}
        onOpenSourceMessage={() => undefined}
        onAskBot={() => undefined}
        onOpenBots={() => undefined}
      />
    </div>
  )
}

const meta = {
  title: "Web/Business/Schedule",
  component: ScheduleSpecimen,
  tags: ["autodocs", "ai-generated"],
  parameters: { layout: "fullscreen" },
  args: { initialView: "week" },
} satisfies Meta<typeof ScheduleSpecimen>

export default meta
type Story = StoryObj<typeof meta>

export const WeekView: Story = {
  args: { initialView: "week" },
}

export const AgendaView: Story = {
  args: { initialView: "agenda" },
}

export const LoadingSkeleton: Story = {
  render: () => (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background">
      <SchedulePageSkeleton reserveBackSlot />
    </div>
  ),
}
