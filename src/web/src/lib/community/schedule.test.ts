import { QueryClient } from "@tanstack/react-query"
import { describe, expect, it, vi } from "vitest"
import { handleScheduleChanged } from "@/hooks/community/community-ws/schedule-events"
import { communityKeys } from "@/lib/query-keys"
import {
  formatScheduleRecurrence,
  mapScheduleListResponse,
  type ScheduleListResponseDto,
} from "./schedule"

describe("schedule client mapping", () => {
  it("formats recurring rules into readable summaries", () => {
    expect(formatScheduleRecurrence(null)).toEqual({
      recurring: false,
      label: "One-time",
      ruleText: null,
    })
    expect(
      formatScheduleRecurrence({
        freq: "weekly",
        interval: 1,
        byWeekday: [1, 3, 5],
        count: 10,
      }),
    ).toEqual({
      recurring: true,
      label: "Weekly · Mon, Wed, Fri",
      ruleText: "10 times",
    })
    expect(formatScheduleRecurrence({ freq: "daily", interval: 2 })).toEqual({
      recurring: true,
      label: "Every 2 days",
      ruleText: null,
    })
  })

  it("maps events, occurrences, creators, and redacts inaccessible source messages", () => {
    const response: ScheduleListResponseDto = {
      creators: [
        { id: "bot_alli", handle: "@Alli#6011", name: "Alli", avatarVersion: 2, isBot: true },
        { id: "bot_elwira", handle: "@Elwira#8700", name: "Elwira", avatarVersion: 1, isBot: true },
      ],
      events: [
        {
          id: "sch_1",
          title: "Standup digest",
          description: "Post summary",
          createdBy: { id: "bot_alli", handle: "@Alli#6011", name: "Alli", avatarVersion: 2, isBot: true },
          startAt: "2026-11-26T01:00:00.000Z",
          durationMinutes: 30,
          timeZone: "Asia/Shanghai",
          recurrence: { freq: "daily", interval: 1 },
          nextRunAt: "2026-11-27T01:00:00.000Z",
          sourceMessage: {
            id: "msg_1",
            accessible: true,
            status: "accessible",
            ref: "/Alook#5620/gus-board#42",
            channelRef: "/Alook#5620/gus-board",
            seq: 42,
            preview: "Share daily update here",
          },
          lastExecution: {
            scheduledAt: "2026-11-26T01:00:00.000Z",
            status: "completed",
            ackedAt: "2026-11-26T01:04:00.000Z",
            lastError: null,
            updatedAt: "2026-11-26T01:04:00.000Z",
          },
          createdAt: "2026-11-25T04:00:00.000Z",
          updatedAt: "2026-11-25T04:00:00.000Z",
        },
        {
          id: "sch_lost",
          title: "Lost-access reminder",
          description: "",
          createdBy: { id: "bot_elwira", handle: "@Elwira#8700", name: "Elwira", avatarVersion: 1, isBot: true },
          startAt: "2026-11-26T05:00:00.000Z",
          durationMinutes: 30,
          timeZone: "Asia/Shanghai",
          recurrence: null,
          nextRunAt: null,
          sourceMessage: {
            id: "msg_deleted",
            accessible: false,
            status: "deleted",
            ref: null,
            channelRef: null,
            seq: null,
            preview: null,
          },
          lastExecution: {
            scheduledAt: "2026-11-26T05:00:00.000Z",
            status: "blocked_access",
            ackedAt: null,
            lastError: "source_deleted",
            updatedAt: "2026-11-26T05:00:01.000Z",
          },
          createdAt: "2026-11-25T04:00:00.000Z",
          updatedAt: "2026-11-25T04:00:00.000Z",
        },
      ],
      occurrences: [
        {
          eventId: "sch_1",
          occurrenceKey: "sch_1:2026-11-26T01:00:00.000Z",
          startAt: "2026-11-26T01:00:00.000Z",
          endAt: "2026-11-26T01:30:00.000Z",
          runStatus: "completed",
        },
      ],
    }

    const mapped = mapScheduleListResponse(
      response,
      new Map([["bot_alli", "/avatars/alli.png"]]),
    )
    expect(mapped.creators).toHaveLength(2)
    expect(mapped.creators[0]?.avatarUrl).toBe("/avatars/alli.png")
    expect(mapped.occurrences).toHaveLength(1)
    expect(mapped.occurrences[0]?.runStatus).toBe("completed")
    expect(mapped.occurrences[0]?.event.lastExecution?.ackedAt).toBe("2026-11-26T01:04:00.000Z")
    expect(mapped.occurrences[0]?.event.sourceMessage.excerpt).toBe("Share daily update here")

    const lost = mapped.events.find((e) => e.id === "sch_lost")
    expect(lost?.sourceMessage.accessible).toBe(false)
    expect(lost?.sourceMessage.excerpt).toBeNull()
    expect(lost?.sourceMessage.channelLabel).toBeNull()
    expect(lost?.sourceMessage.unavailableReason).toContain("deleted")
  })

  it("invalidates active schedule queries on community:schedule.changed", async () => {
    const queryClient = new QueryClient()
    const spy = vi.spyOn(queryClient, "invalidateQueries")
    await handleScheduleChanged(
      { type: "community:schedule.changed", eventId: "sch_1", reason: "updated" },
      { queryClient },
    )
    expect(spy).toHaveBeenCalledWith({
      queryKey: communityKeys.schedule(),
      refetchType: "active",
    })
  })
})
