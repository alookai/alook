import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Msg } from "@/lib/community/models/message"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
  messageProfilePatches,
  writeCommunityProfilePatches,
} from "./profile-seed"
import {
  createCommunityDbRegistry,
  registerCommunityDbRegistry,
  type CommunityDbRegistry,
} from "@/lib/community-db/collections"

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({ apiFetch }))

let registry: CommunityDbRegistry
let unregister: () => void

function chat(overrides: Partial<Msg> = {}): Msg {
  return {
    id: "m1",
    type: "chat",
    content: "hello",
    ...overrides,
  }
}

beforeEach(async () => {
  apiFetch.mockReset()
  registry = createCommunityDbRegistry(new QueryClient(), "viewer")
  await registry.preload()
  unregister = registerCommunityDbRegistry(registry)
})

afterEach(async () => {
  unregister()
  await registry.cleanup()
})

describe("communityUserProfilePatch", () => {
  it("maps only canonical profile fields and never treats row presence or sub as profile data", () => {
    const patch = communityUserProfilePatch("u1", {
      name: "Alice",
      discriminator: "0001",
      avatar: "/alice.png",
      avatarVersion: 4,
      status: "online",
      sub: "placeholder biography",
      statusEmoji: null,
      statusText: "Heads down",
    })

    expect(patch).toEqual({
      id: "u1",
      identityAbout: { name: "Alice", discriminator: "0001" },
      avatar: { avatar: "/alice.png", avatarVersion: 4 },
      status: { statusEmoji: null, statusText: "Heads down" },
    })
    expect(patch).not.toHaveProperty("presence")
    expect(patch.identityAbout).not.toHaveProperty("aboutMe")
  })
})

describe("messageProfilePatches", () => {
  it("extracts typed author, reply, thread, and approval identities", () => {
    const patches = messageProfilePatches([chat({
      authorId: "author",
      authorName: "Author",
      authorAvatar: "/author.png",
      authorAvatarVersion: 7,
      replyTo: {
        id: "prior",
        authorId: "reply",
        authorName: "Reply",
        text: "prior text",
      },
      thread: {
        id: "thread",
        name: "Thread",
        messageCount: 1,
        participants: [{
          id: "participant",
          name: "Participant",
          avatar: "/participant.png",
          avatarVersion: 3,
        }],
      },
      approval: {
        friendshipId: "friendship",
        status: "pending",
        waitingOn: "you",
        otherProfile: {
          id: "other",
          name: "Other",
          discriminator: "0002",
          image: null,
          avatarVersion: 2,
        },
        botProfile: {
          id: "bot",
          name: "Bot",
          discriminator: "0003",
          image: "/bot.png",
          avatarVersion: 5,
        },
        waitingOnProfile: null,
      },
    })])

    expect(patches).toEqual([
      {
        id: "author",
        identityAbout: { name: "Author" },
        avatar: { avatar: "/author.png", avatarVersion: 7 },
      },
      { id: "reply", identityAbout: { name: "Reply" } },
      {
        id: "participant",
        identityAbout: { name: "Participant" },
        avatar: { avatar: "/participant.png", avatarVersion: 3 },
      },
      {
        id: "other",
        identityAbout: { name: "Other", discriminator: "0002" },
        avatar: { avatar: "O", avatarVersion: 2 },
      },
      {
        id: "bot",
        identityAbout: { name: "Bot", discriminator: "0003" },
        avatar: { avatar: "/bot.png", avatarVersion: 5 },
      },
    ])
  })
})

describe("profile seeding boundaries", () => {
  it("writes profile patches into the canonical collection", () => {
    writeCommunityProfilePatches([{
      id: "u1",
      identityAbout: { name: "Alice", discriminator: "0001" },
      avatar: { avatar: "/alice.png", avatarVersion: 8 },
    }], registry)

    expect(registry.collections.profiles.get("u1")).toMatchObject({
      name: "Alice",
      avatar: "/alice.png",
      avatarVersion: 8,
    })
  })

  it("returns the raw API object while updating its canonical profile projection", async () => {
    const raw = { member: { id: "u2", name: "API Alice" } }
    apiFetch.mockResolvedValueOnce(raw)

    const result = await apiFetchProfiles(
      "/profiles",
      (data: typeof raw) => [{
        id: data.member.id,
        identityAbout: { name: data.member.name },
      }],
    )

    expect(result).toBe(raw)
    expect(apiFetch).toHaveBeenCalledWith("/profiles")
    expect(registry.collections.profiles.get("u2")?.name).toBe("API Alice")
  })

  it("merges partial updates without erasing canonical fields", () => {
    writeCommunityProfilePatches([{
      id: "u3",
      identityAbout: { name: "Alice", discriminator: "0003", aboutMe: "hello" },
      avatar: { avatar: "/alice.png", avatarVersion: 3 },
    }], registry)
    writeCommunityProfilePatches([{
      id: "u3",
      status: { statusEmoji: "🌱", statusText: "Growing" },
    }], registry)
    writeCommunityProfilePatches([{
      id: "u3",
      avatar: { avatar: "/stale.png", avatarVersion: 2 },
      status: { statusEmoji: null, statusText: null },
    }], registry)

    expect(registry.collections.profiles.get("u3")).toMatchObject({
      name: "Alice",
      discriminator: "0003",
      aboutMe: "hello",
      avatar: "/alice.png",
      avatarVersion: 3,
      statusEmoji: null,
      statusText: null,
    })
  })
})
