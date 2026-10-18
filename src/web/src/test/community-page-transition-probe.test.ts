import { describe, expect, it } from "vitest"
import { hasCompletedCommunityPageTransition, type PageTransitionRecord } from "./e2e-ui/_fixtures/community-page-transition-probe"

function record(transforms: string[], entering = true): PageTransitionRecord {
  return { ready: true, readyError: null, finished: true, finishedError: null, targetHref: "/c/me/dm1",
    animations: [{ name: entering ? "community-page-enter" : "community-page-exit",
      pseudo: entering ? "::view-transition-new(page)" : "::view-transition-old(page)", transforms }] }
}

const action = { afterIndex: 0, targetHref: "/c/me/dm1" }

describe("compiled community snapshot evidence", () => {
  it.each([
    ["translateX(100%)", "translateX(0px)"],
    ["translate(100%)", "translate(0px)"],
    ["translate(100%, 0px)", "translate(0px, 0px)"],
    ["translateX(100%)", "translateX(0)"],
  ])("accepts the same full-width horizontal geometry after CSS serialization: %s → %s", (from, to) => {
    expect(hasCompletedCommunityPageTransition([record([from, to])], "community-page-enter", action)).toBe(true)
    expect(hasCompletedCommunityPageTransition([record([to, from], false)], "community-page-exit", action)).toBe(true)
  })

  it.each([
    ["translate(50%)", "translate(0px)"],
    ["translate(100px)", "translate(0px)"],
    ["translate(-100%)", "translate(0px)"],
    ["translateY(100%)", "translateY(0px)"],
    ["translate(100%, 1px)", "translate(0px)"],
    ["translate(100%) rotate(1deg)", "translate(0px)"],
    ["translate(100%)", "translate(1px)"],
    ["none", "none"],
  ])("rejects incomplete, reversed or nonhorizontal geometry: %s → %s", (from, to) => {
    expect(hasCompletedCommunityPageTransition([record([from, to])], "community-page-enter", action)).toBe(false)
  })

  it.each(["not ready", "ready rejected", "not finished", "finish rejected", "wrong pseudo", "wrong animation", "wrong direction"])("requires intact actual transition evidence: %s", (condition) => {
    const evidence = record(["translate(100%)", "translate(0px)"])
    if (condition === "not ready") evidence.ready = false
    if (condition === "ready rejected") evidence.readyError = "skipped"
    if (condition === "not finished") evidence.finished = false
    if (condition === "finish rejected") evidence.finishedError = "aborted"
    if (condition === "wrong pseudo") evidence.animations[0].pseudo = "::view-transition-old(page)"
    if (condition === "wrong animation") evidence.animations[0].name = "other-enter"
    if (condition === "wrong direction") evidence.animations[0].transforms.reverse()
    expect(hasCompletedCommunityPageTransition([evidence], "community-page-enter", action)).toBe(false)
  })
  it("does not reuse an earlier action or a completed transition to another target", () => {
    const previous = record(["translate(100%)", "translate(0px)"])
    const otherTarget = { ...previous, targetHref: "/c/me/dm2" }
    expect(hasCompletedCommunityPageTransition([previous], "community-page-enter", { ...action, afterIndex: 1 })).toBe(false)
    expect(hasCompletedCommunityPageTransition([otherTarget], "community-page-enter", action)).toBe(false)
    expect(hasCompletedCommunityPageTransition([previous, otherTarget], "community-page-enter",
      { afterIndex: 1, targetHref: "/c/me/dm2" })).toBe(true)
  })

})
