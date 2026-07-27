import { describe, it, expect } from "vitest"
import {
  POLL_INTERVAL_MS, OFFLINE_THRESHOLD_MS, EVENT_POLL_INTERVAL_MS, AGENT_HANDLE_MIN_LENGTH,
  COMMUNITY_MACHINE_HEARTBEAT_MS, COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS,
  TaskStatus, TERMINAL_TASK_STATUSES, isTerminalTaskStatus,
  IssueStatus, ACTIVE_ISSUE_STATUSES, TERMINAL_ISSUE_STATUSES, isTerminalIssueStatus,
  MeetingStatus, TERMINAL_MEETING_STATUSES,
} from "../src/constants"
import {
  NOTIF_LEVELS, NOTIFICATION_LEVEL_VALUES, USE_SERVER_DEFAULT,
  notifLevelDisplay, normalizeNotifLevel,
} from "../src/constants/community"

describe("constants", () => {
  it("OFFLINE_THRESHOLD_MS is 30s", () => expect(OFFLINE_THRESHOLD_MS).toBe(30_000))
  it("AGENT_HANDLE_MIN_LENGTH is 4", () => expect(AGENT_HANDLE_MIN_LENGTH).toBe(4))
  it("EVENT_POLL < POLL_INTERVAL", () => expect(EVENT_POLL_INTERVAL_MS).toBeLessThan(POLL_INTERVAL_MS))
  // Derived-pair invariant: the DO alarm re-arms on the heartbeat cadence and
  // only flips a machine offline after the offline threshold elapses, so the
  // heartbeat MUST be strictly less than the offline threshold or machines
  // flap offline at the heartbeat boundary.
  it("machine heartbeat < machine offline threshold", () =>
    expect(COMMUNITY_MACHINE_HEARTBEAT_MS).toBeLessThan(COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS))
  it("machine offline threshold is derived as 3× heartbeat", () =>
    expect(COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS).toBe(3 * COMMUNITY_MACHINE_HEARTBEAT_MS))
})

describe("TaskStatus", () => {
  it("includes superseded", () => {
    expect(TaskStatus.SUPERSEDED).toBe("superseded")
  })

  it("TERMINAL_TASK_STATUSES includes all terminal statuses", () => {
    expect(TERMINAL_TASK_STATUSES).toContain("completed")
    expect(TERMINAL_TASK_STATUSES).toContain("failed")
    expect(TERMINAL_TASK_STATUSES).toContain("cancelled")
    expect(TERMINAL_TASK_STATUSES).toContain("superseded")
  })

  it("TERMINAL_TASK_STATUSES does not include active statuses", () => {
    expect(TERMINAL_TASK_STATUSES).not.toContain("queued")
    expect(TERMINAL_TASK_STATUSES).not.toContain("dispatched")
    expect(TERMINAL_TASK_STATUSES).not.toContain("running")
  })

  it("isTerminalTaskStatus returns true for terminal statuses", () => {
    expect(isTerminalTaskStatus("completed")).toBe(true)
    expect(isTerminalTaskStatus("failed")).toBe(true)
    expect(isTerminalTaskStatus("cancelled")).toBe(true)
    expect(isTerminalTaskStatus("superseded")).toBe(true)
  })

  it("isTerminalTaskStatus returns false for active statuses", () => {
    expect(isTerminalTaskStatus("queued")).toBe(false)
    expect(isTerminalTaskStatus("dispatched")).toBe(false)
    expect(isTerminalTaskStatus("running")).toBe(false)
  })
})

describe("IssueStatus", () => {
  it("has all expected status values", () => {
    expect(IssueStatus.TODO).toBe("todo")
    expect(IssueStatus.IN_PROGRESS).toBe("in_progress")
    expect(IssueStatus.REVIEW).toBe("review")
    expect(IssueStatus.DONE).toBe("done")
    expect(IssueStatus.CLOSED).toBe("closed")
    expect(IssueStatus.CANCELED).toBe("canceled")
    expect(IssueStatus.FAILED).toBe("failed")
  })

  it("ACTIVE_ISSUE_STATUSES contains non-terminal statuses", () => {
    expect(ACTIVE_ISSUE_STATUSES).toContain("todo")
    expect(ACTIVE_ISSUE_STATUSES).toContain("in_progress")
    expect(ACTIVE_ISSUE_STATUSES).toContain("review")
    expect(ACTIVE_ISSUE_STATUSES).not.toContain("done")
  })

  it("TERMINAL_ISSUE_STATUSES contains terminal statuses", () => {
    expect(TERMINAL_ISSUE_STATUSES).toContain("done")
    expect(TERMINAL_ISSUE_STATUSES).toContain("closed")
    expect(TERMINAL_ISSUE_STATUSES).toContain("canceled")
    expect(TERMINAL_ISSUE_STATUSES).toContain("failed")
  })

  it("isTerminalIssueStatus returns true for terminal statuses", () => {
    expect(isTerminalIssueStatus("done")).toBe(true)
    expect(isTerminalIssueStatus("closed")).toBe(true)
    expect(isTerminalIssueStatus("canceled")).toBe(true)
    expect(isTerminalIssueStatus("failed")).toBe(true)
  })

  it("isTerminalIssueStatus returns false for active statuses", () => {
    expect(isTerminalIssueStatus("todo")).toBe(false)
    expect(isTerminalIssueStatus("in_progress")).toBe(false)
    expect(isTerminalIssueStatus("review")).toBe(false)
  })
})

describe("NOTIF_LEVELS single source (H3)", () => {
  it("covers exactly the three DB level values, in order", () => {
    expect(NOTIF_LEVELS.map((l) => l.value)).toEqual([...NOTIFICATION_LEVEL_VALUES])
  })

  it("uses the canonical display spellings (A8 regression — 'All Messages', capital M)", () => {
    const display = Object.fromEntries(NOTIF_LEVELS.map((l) => [l.value, l.display]))
    expect(display.all).toBe("All Messages")
    expect(display.mentions).toBe("Only @mentions")
    expect(display.nothing).toBe("Nothing")
  })

  it("notifLevelDisplay maps value → display, passes unknown through", () => {
    expect(notifLevelDisplay("all")).toBe("All Messages")
    expect(notifLevelDisplay("mentions")).toBe("Only @mentions")
    expect(notifLevelDisplay("nothing")).toBe("Nothing")
    expect(notifLevelDisplay("weird")).toBe("weird")
  })

  it("normalizeNotifLevel maps display → value and is idempotent on values", () => {
    expect(normalizeNotifLevel("All Messages")).toBe("all")
    expect(normalizeNotifLevel("Only @mentions")).toBe("mentions")
    expect(normalizeNotifLevel("Nothing")).toBe("nothing")
    expect(normalizeNotifLevel("all")).toBe("all")
    expect(normalizeNotifLevel("mentions")).toBe("mentions")
    expect(normalizeNotifLevel("nothing")).toBe("nothing")
  })

  it("normalizeNotifLevel cannot fall through 'All Messages' to 'mentions' (A8 bug)", () => {
    // The A8 regression: a lowercase 'm' spelling fell through to 'mentions'.
    // The single source guarantees the display spelling round-trips to 'all'.
    expect(normalizeNotifLevel(notifLevelDisplay("all"))).toBe("all")
  })

  it("normalizeNotifLevel keeps the 'mentions' fall-through for unrecognised input", () => {
    expect(normalizeNotifLevel("Use Server Default")).toBe("mentions")
    expect(normalizeNotifLevel("garbage")).toBe("mentions")
  })

  it("USE_SERVER_DEFAULT is the channel inherit sentinel, not a real level", () => {
    expect(USE_SERVER_DEFAULT).toBe("Use Server Default")
    expect(NOTIFICATION_LEVEL_VALUES).not.toContain(USE_SERVER_DEFAULT as never)
  })
})

describe("MeetingStatus", () => {
  it("has expected status values", () => {
    expect(MeetingStatus.PENDING).toBe("pending")
    expect(MeetingStatus.SCHEDULED).toBe("scheduled")
    expect(MeetingStatus.JOINING).toBe("joining")
    expect(MeetingStatus.RECORDING).toBe("recording")
    expect(MeetingStatus.COMPLETED).toBe("completed")
    expect(MeetingStatus.FAILED).toBe("failed")
  })

  it("TERMINAL_MEETING_STATUSES contains only completed and failed", () => {
    expect(TERMINAL_MEETING_STATUSES).toHaveLength(2)
    expect(TERMINAL_MEETING_STATUSES).toContain("completed")
    expect(TERMINAL_MEETING_STATUSES).toContain("failed")
  })
})
