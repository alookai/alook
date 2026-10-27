import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { act, fireEvent } from "@/test/react-dom-harness"
import { configureTelemetry, installTelemetrySink, retireTelemetry } from "@/lib/observability/telemetry"
import { installMessageScrollFixture, restoreMessageScrollFixture, mount, message, runFrames, scrollFixture } from "@/test/message-scroll-fixture"
import { createCommunityQueryOwner } from "@/test/community-query-owner"
import { captureChannelMetadataToken } from "@/lib/community/conversation-qualification"
import { virtualListPositionKey, type VirtualListPositionSnapshot } from "@/lib/community/virtual-list-position"

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
  expect(terminals()).toContainEqual(expect.objectContaining({ position_owner: "target", position_reason: "settled", target_coverage: "covered", position_source: "explicit_target", position_snapshot: "not_requested" }))
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

it("records an explicit imperative jump even when no target-consumed callback is requested", () => {
  mount()
  act(() => scrollFixture.latest.jumpTo("m4", "auto"))
  runFrames()
  expect(terminals().at(-1)).toMatchObject({ position_owner: "target", position_source: "explicit_target", position_snapshot: "not_requested", position_reason: "settled" })
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

it.each(["valid", "missing", "fingerprint", "viewport", "padding", "anchor", "expired", "version"] as const)("records actual snapshot admission for %s without exporting its values", async state => {
  const { client } = await createCommunityQueryOwner()
  const positionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages" as const, tag: null }
  const items = Array.from({ length: 40 }, (_, index) => message(`m${index}`))
  const first = mount({ items, positionScope })
  first.move(800)
  const key = virtualListPositionKey(positionScope)
  const snapshot = client.getQueryData<VirtualListPositionSnapshot>(key)!
  expect(snapshot.offset).toBe(800)
  first.view.unmount()
  events.length = 0
  if (state === "missing") client.removeQueries({ queryKey: key, exact: true })
  else if (state === "viewport") scrollFixture.width += 1
  else if (state !== "valid") client.setQueryData(key, { ...snapshot,
    ...(state === "fingerprint" ? { fingerprint: "PRIVATE-position-fingerprint" } : {}),
    ...(state === "padding" ? { paddingEnd: snapshot.paddingEnd + 1 } : {}),
    ...(state === "anchor" ? { anchorKey: "PRIVATE-position-anchor" } : {}),
    ...(state === "expired" ? { at: Date.now() - 300001 } : {}),
    ...(state === "version" ? { version: 2 } : {}),
  })
  const restored = mount({ items, positionScope })
  const expected = { valid: "accepted", missing: "missing", fingerprint: "fingerprint_mismatch", viewport: "viewport_mismatch",
    padding: "padding_mismatch", anchor: "anchor_missing", expired: "expired", version: "invalid_version" }[state]
  expect(terminals()).toEqual([expect.objectContaining({ position_owner: "initial", position_reason: "settled",
    position_source: state === "valid" ? "snapshot" : "tail", position_snapshot: expected })])
  if (state === "valid") expect(restored.root.scrollTop).toBeCloseTo(800, 0)
  expect(JSON.stringify(events)).not.toContain("PRIVATE-position")
})

it.each(["read_anchor", "new_divider", "tail"] as const)("records the actual %s selection instead of inferring it from initial/settled", source => {
  mount({ ...(source === "read_anchor" ? { initialPositionMessageId: "m4" } : {}),
    ...(source === "new_divider" ? { newDividerBefore: "m4" } : {}) })
  expect(terminals()).toEqual([expect.objectContaining({ position_source: source, position_snapshot: "no_scope", position_reason: "settled" })])
})

it("keeps a new entry decision separate from a prior successful snapshot restore", async () => {
  const { client } = await createCommunityQueryOwner()
  const positionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages" as const, tag: null }
  const first = mount({ positionScope })
  first.move(600)
  first.view.unmount()
  events.length = 0
  const returned = mount({ positionScope, positionEntry: {} })
  expect(terminals()).toEqual([expect.objectContaining({ position_source: "snapshot", position_snapshot: "accepted" })])
  returned.update({ positionEntry: {} })
  expect(terminals()).toHaveLength(2)
  expect(terminals()[1]).toMatchObject({ position_source: "tail", position_snapshot: "entry_changed" })
  returned.update({ positionEntry: {}, positionDataState: "pending", initialScrollReady: false })
  fireEvent.wheel(returned.root, { deltaY: -20 })
  expect(terminals().at(-1)).toMatchObject({ position_source: "unknown", position_snapshot: "entry_changed", position_reason: "manual_takeover" })
})

it("records a fingerprint changed after lookup as a rejected restore at actual admission", async () => {
  const { client } = await createCommunityQueryOwner()
  const positionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages" as const, tag: null }
  const items = Array.from({ length: 40 }, (_, index) => message(`m${index}`))
  const first = mount({ items, positionScope })
  first.move(800)
  first.view.unmount()
  events.length = 0
  const returned = mount({ items, positionScope, initialScrollReady: false, positionDataState: "pending" })
  const changed = items.map((item, index) => index === 0 ? { ...item, m: { ...item.m, content: "Changed shape" } } : item)
  returned.update({ items: changed, initialScrollReady: true, positionDataState: "ready" })
  expect(terminals()).toEqual([expect.objectContaining({ position_source: "tail", position_snapshot: "fingerprint_mismatch", position_reason: "settled" })])
})

it("does not call an available snapshot accepted when a user cancels before admission", async () => {
  const { client } = await createCommunityQueryOwner()
  const positionScope = { proof: captureChannelMetadataToken(client, "A"), kind: "messages" as const, tag: null }
  const first = mount({ positionScope })
  first.move(600)
  first.view.unmount()
  events.length = 0
  const returned = mount({ positionScope, initialScrollReady: false, positionDataState: "pending" })
  fireEvent.wheel(returned.root, { deltaY: -20 })
  expect(terminals()).toEqual([expect.objectContaining({ position_source: "unknown", position_snapshot: "available", position_reason: "manual_takeover" })])
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
