import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"
import { installMessageScrollFixture, restoreMessageScrollFixture, mount, runFrames, scrollFixture } from "@/test/message-scroll-fixture"

let events: Array<{ name: string; attributes: Record<string, string> }>
beforeEach(() => {
  installMessageScrollFixture()
  events = []
  configureTelemetry({ session_id: "position-session" }, true)
  installTelemetrySink(event => events.push(event))
})
afterEach(() => { retireTelemetry(); restoreMessageScrollFixture() })
const terminals = () => events.filter(event => event.name === "position.finish").map(event => event.attributes)

it("finishes a covered local target while newer continuity remains pending without granting reads or paging", () => {
  const positioned = vi.fn()
  const h = mount({ scrollToMessageId: "m4", positionDataState: "pending", targetPositionDataState: "ready", onScrollTargetPositioned: positioned })
  expect(positioned).toHaveBeenCalledExactlyOnceWith("m4")
  expect(scrollFixture.latest.readPositionReady).toBe(false)
  expect(scrollFixture.latest.paginationEnabled).toBe(false)
  expect(terminals()).toContainEqual(expect.objectContaining({ position_owner: "target", position_reason: "settled", target_coverage: "covered" }))
  const count = terminals().length
  h.update({ positionDataState: "ready" })
  runFrames()
  expect(terminals()).toHaveLength(count)
  expect(scrollFixture.latest.readPositionReady).toBe(true)
})

it("records real geometry success once and records a new target independently of initial presentation", () => {
  const h = mount({ positionDataState: "ready" })
  expect(terminals()).toEqual([expect.objectContaining({ position_owner: "initial", position_reason: "settled" })])
  h.update({ scrollToMessageId: "m4" })
  expect(terminals()).toHaveLength(2)
  expect(terminals()[1]).toMatchObject({ position_owner: "target", position_reason: "settled" })
  h.view.unmount()
  expect(terminals()).toHaveLength(2)
})

it("retires an absent ready target without geometry or a false successful finish", () => {
  scrollFixture.height = 0
  const cancelled = vi.fn()
  const h = mount({ scrollToMessageId: "absent", positionDataState: "pending", targetPositionDataState: "pending", onScrollTargetCancelled: cancelled })
  expect(terminals().some(event => event.position_owner === "target")).toBe(false)
  h.update({ targetPositionDataState: "ready" })
  expect(cancelled).toHaveBeenCalledExactlyOnceWith("absent")
  expect(terminals().filter(event => event.position_owner === "target")).toEqual([expect.objectContaining({ position_reason: "target_missing", target_coverage: "uncovered" })])
  expect(scrollFixture.latest.readPositionReady).toBe(false)
})

it.each(["manual", "hidden", "entry", "unmount"] as const)("records %s retirement once at the existing owner", reason => {
  scrollFixture.height = 0
  const h = mount({ positionDataState: "pending", initialScrollReady: false, positionEntry: {} })
  if (reason === "manual") fireEvent.wheel(h.root, { deltaY: 20 })
  else if (reason === "hidden") h.update({ positioningActive: false })
  else if (reason === "entry") h.update({ positionEntry: {} })
  else h.view.unmount()
  const expected = { manual: "manual_takeover", hidden: "hidden", entry: "entry_changed", unmount: "retired" }[reason]
  expect(terminals().filter(event => event.position_reason === expected)).toHaveLength(1)
  expect(terminals().some(event => event.position_reason === "settled")).toBe(false)
})

it.each(["late-consent", "retired-session"] as const)("does not export an old attempt after %s", boundary => {
  if (boundary === "late-consent") configureTelemetry({}, false)
  const h = mount({ positionDataState: "pending", initialScrollReady: false })
  if (boundary === "retired-session") retireTelemetry()
  configureTelemetry({ session_id: "replacement-session" }, true)
  installTelemetrySink(event => events.push(event))
  act(() => h.update({ positionDataState: "ready", initialScrollReady: true }))
  expect(terminals()).toEqual([])
})
