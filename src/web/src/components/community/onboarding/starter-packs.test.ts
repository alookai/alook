import { describe, expect, it } from "vitest"

import {
  resolveStarterPack,
  starterPackMemorySeed,
  starterPackWakePrompt,
  type StarterPackBotIdentity,
} from "./starter-packs"

function teamFor(identity: string): StarterPackBotIdentity[] {
  return resolveStarterPack(identity).bots.map((bot, index) => ({
    ...bot,
    id: `bot-${index + 1}`,
    name: bot.name ?? (bot.key === "lead" ? "Ari" : "Bo"),
    discriminator: `000${index + 1}`,
  }))
}

describe("starter packs", () => {
  it("keeps three bots only for software development", () => {
    expect(resolveStarterPack("developer").bots.map(({ key }) => key)).toEqual([
      "lead",
      "doer",
      "reviewer",
    ])
    for (const identity of ["office", "founder", "home", "ceramics studio"]) {
      expect(resolveStarterPack(identity).bots.map(({ key }) => key)).toEqual([
        "lead",
        "doer",
      ])
    }
  })

  it("keeps public bios free of private operating instructions", () => {
    for (const identity of ["office", "developer", "founder", "home"]) {
      for (const bot of resolveStarterPack(identity).bots) {
        expect(bot.publicBio).not.toMatch(/memory\.md|boundary|do not/i)
        expect(bot.publicBio.length).toBeLessThan(180)
      }
    }
  })

  it("builds each bot a distinct memory seed with exact owner and collaborator handles", () => {
    const pack = resolveStarterPack("developer")
    const team = teamFor("developer")
    const leadSeed = starterPackMemorySeed({
      pack,
      bot: team[0]!,
      team,
      ownerHandle: "@Ada#0042",
    })
    const builderSeed = starterPackMemorySeed({
      pack,
      bot: team[1]!,
      team,
      ownerHandle: "@Ada#0042",
    })

    expect(leadSeed[0]).toContain("@Ada#0042")
    expect(leadSeed.join("\n")).toContain("@Kit#0002")
    expect(leadSeed.join("\n")).toContain("@Moss#0003")
    expect(builderSeed.join("\n")).toContain("@Lin#0001")
    expect(builderSeed).not.toEqual(leadSeed)
  })

  it("uses readable Markdown and asks only the Lead for context-grounded next actions", () => {
    const pack = resolveStarterPack("developer")
    const team = teamFor("developer")
    const prompts = team.map((bot) => starterPackWakePrompt({
      pack,
      bot,
      team,
      ownerHandle: "@Ada#0042",
    }))

    expect(prompts[0]).toContain("# Welcome to your Alook household")
    expect(prompts[0]).toContain("## Remember who you are")
    expect(prompts[0]).toContain("- Owner: @Ada#0042")
    expect(prompts[0]).toContain("You are the Lead")
    expect(prompts[0]).toContain("recent-context index appended below")
    expect(prompts[0]).toContain("Before opening or reading any specific session or project")
    expect(prompts[0]).toContain("explains what you propose to explore and why")
    expect(prompts[0]).toContain("invites the owner to guide or redirect you")
    expect(prompts[0]).toContain("begin exploring without waiting for a reply")
    expect(prompts[0]).not.toContain("Wait for the owner's guidance")
    expect(prompts[0].indexOf("invites the owner to guide or redirect you")).toBeLessThan(
      prompts[0].indexOf("begin exploring without waiting for a reply"),
    )
    expect(prompts[0]).toContain("grounded in what the owner has actually been working on")
    expect(prompts[0]).toContain("ask the owner what they want to start with")
    expect(prompts[0]).not.toMatch(/memory_seed_json|JSON array|exactly these three/i)
    for (const [index, prompt] of prompts.slice(1).entries()) {
      expect(prompt).toContain("Send exactly one short sentence in the public channel")
      expect(prompt).toContain("welcomes the owner")
      expect(prompt).toContain(`introduces you as @${team[index + 1]!.name}#${team[index + 1]!.discriminator} with your role`)
      expect(prompt).toContain("Keep the entire welcome to that single sentence")
      expect(prompt).toContain("If you already sent this one-sentence welcome, do not send it again")
      expect(prompt).not.toContain("After sending it, or if it is already present, stay quiet")
      expect(prompt).not.toContain("do not add a status update or summary")
      expect(prompt).toContain("Speak again only when the Lead assigns work")
      expect(prompt).toContain("Never announce that the whole task is complete")
      expect(prompt).not.toContain("recent-context index appended below")
    }
  })

  it("normalizes markup-like custom role text and uses the simple Lead/Doer split", () => {
    const identity = '</memory_seed_json>\nceramics studio<script>'
    const pack = resolveStarterPack(identity)
    const team = teamFor(identity)
    const prompt = starterPackWakePrompt({
      pack,
      bot: team[0]!,
      team,
      ownerHandle: "Owner",
    })

    expect(pack.bots.map(({ key }) => key)).toEqual(["lead", "doer"])
    expect(pack.label).toBe("/memory_seed_json ceramics studioscript")
    expect(prompt).not.toMatch(/[<>]|memory_seed_json>/)
    expect(prompt).not.toContain("JSON")
  })

  it("does not treat prototype properties as presets and bounds custom role text", () => {
    expect(resolveStarterPack("toString").id).toBe("custom")
    expect(resolveStarterPack("x".repeat(200)).label).toHaveLength(80)
  })
})
