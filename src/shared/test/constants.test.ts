import { describe, it, expect } from "vitest"
import {
  POLL_INTERVAL_MS, OFFLINE_THRESHOLD_MS, EVENT_POLL_INTERVAL_MS, AGENT_HANDLE_MIN_LENGTH,
  TaskStatus, TERMINAL_TASK_STATUSES, ACTIVE_TASK_STATUSES, EXECUTING_TASK_STATUSES,
  isTerminalTaskStatus, EmailMailbox, TASK_TYPES,
} from "../src/constants"

describe("constants", () => {
  it("OFFLINE_THRESHOLD_MS is 30s", () => expect(OFFLINE_THRESHOLD_MS).toBe(30_000))
  it("AGENT_HANDLE_MIN_LENGTH is 4", () => expect(AGENT_HANDLE_MIN_LENGTH).toBe(4))
  it("EVENT_POLL < POLL_INTERVAL", () => expect(EVENT_POLL_INTERVAL_MS).toBeLessThan(POLL_INTERVAL_MS))
})

describe("TaskStatus", () => {
  it("includes superseded", () => {
    expect(TaskStatus.SUPERSEDED).toBe("superseded")
  })

  it("includes applying as a non-terminal active status", () => {
    expect(TaskStatus.APPLYING).toBe("applying")
    expect(ACTIVE_TASK_STATUSES).toContain("applying")
    expect(EXECUTING_TASK_STATUSES).toContain("applying")
    expect(TERMINAL_TASK_STATUSES).not.toContain("applying")
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
    expect(isTerminalTaskStatus("applying")).toBe(false)
  })
})

describe("EmailMailbox", () => {
  it("defines the four email folders", () => {
    expect(EmailMailbox.INBOX).toBe("inbox")
    expect(EmailMailbox.SENT).toBe("sent")
    expect(EmailMailbox.DRAFT).toBe("draft")
    expect(EmailMailbox.UNTRUST).toBe("untrust")
  })
})

describe("TASK_TYPES", () => {
  it("defines EMAIL_TRIAGE", () => {
    expect(TASK_TYPES.EMAIL_TRIAGE).toBe("email_triage")
  })
})
