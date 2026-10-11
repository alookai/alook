import { QueryClient } from "@tanstack/react-query"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Msg } from "@/lib/community/models/message"
import { communityKeys } from "@/lib/query-keys"
import {
  apiFetchProfiles,
  beginCommunityProfileSeed,
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
        avatar: { avatar: null, avatarVersion: 2 },
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
  it.each([null, "/actual.png"])("upgrades real complete identity with avatar %s and retained enrichment", avatar => {
    writeCommunityProfilePatches([{
      id: "complete", identityAbout: { name: "Complete", discriminator: "12345", aboutMe: "actual bio" },
      avatar: { avatar, avatarVersion: 4 }, status: { statusEmoji: null, statusText: "actual status" },
    }], registry)
    expect(registry.collections.profiles.get("complete")).toMatchObject({
      id: "complete", name: "Complete", discriminator: "12345", avatar, avatarVersion: 4,
      aboutMe: "actual bio", statusEmoji: null, statusText: "actual status", identityComplete: true,
    })
    writeCommunityProfilePatches([{ id: "partial", identityAbout: { name: "Partial", discriminator: "67890" }, avatar: { avatarVersion: 4 } }], registry)
    expect(registry.collections.profiles.get("partial")).toMatchObject({ identityComplete: false, avatarVersion: 4 })
    expect(registry.collections.profiles.get("partial")).not.toHaveProperty("avatar")
  })

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

  it("falls back to live collection rows when the canonical query cache is absent", () => {
    writeCommunityProfilePatches([{
      id: "u-cache-gap",
      identityAbout: { name: "Before", discriminator: "0009" },
    }], registry)
    const queryKey = communityKeys.communityDbCollection(registry.scopeId, "profiles")
    registry.queryClient.removeQueries({ queryKey, exact: true })

    writeCommunityProfilePatches([{
      id: "u-cache-gap",
      status: { statusEmoji: "🌱", statusText: "Growing" },
    }], registry)

    expect(registry.collections.profiles.get("u-cache-gap")).toMatchObject({
      name: "Before",
      discriminator: "0009",
      statusEmoji: "🌱",
    })
  })

  it("keeps a known number when a name-only or unknown-number identity is seeded", () => {
    writeCommunityProfilePatches([{ id: "numbered", identityAbout: { name: "Original", discriminator: "123456" }, status: { statusEmoji: "🌱", statusText: "Known" } }], registry)
    const patch = communityUserProfilePatch("numbered", { name: "Renamed", discriminator: "", avatar: "avatar", avatarVersion: 1 })
    expect(patch.identityAbout).toEqual({ name: "Renamed" })
    expect(patch).not.toHaveProperty("status")
    writeCommunityProfilePatches([patch], registry)
    writeCommunityProfilePatches([{ id: "numbered", identityAbout: { name: "Latest", discriminator: "" } }], registry)
    expect(registry.collections.profiles.get("numbered")).toMatchObject({ name: "Latest", discriminator: "123456", statusEmoji: "🌱", statusText: "Known" })
  })

  it("rejects a request snapshot captured by a different registry", async () => {
    const other = createCommunityDbRegistry(new QueryClient(), "other")
    await other.preload()
    const snapshot = beginCommunityProfileSeed(other)

    writeCommunityProfilePatches([{
      id: "u-mismatch",
      identityAbout: { name: "Wrong account" },
    }], registry, { snapshot })

    expect(registry.collections.profiles.get("u-mismatch")).toBeUndefined()
    await other.cleanup()
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
      undefined,
      registry,
    )

    expect(result).toBe(raw)
    expect(apiFetch).toHaveBeenCalledWith("/profiles", expect.objectContaining({ authenticationAccount: "viewer", assertActive: expect.any(Function) }))
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


describe("partial identity facts", () => {
  it("keeps the actual legacy avatar version and does not manufacture an unknown identity", () => {
    expect(communityUserProfilePatch("peer", { name: "Peer", avatar: "P", avatarVersion: 4 }, { legacyPresentation: true }))
      .toEqual({ id: "peer", identityAbout: { name: "Peer" }, avatar: { avatarVersion: 4 } })
    expect(communityUserProfilePatch("peer", {})).toEqual({ id: "peer", identityAbout: {} })
    expect(communityUserProfilePatch("peer", { name: "Peer", avatar: "P", avatarVersion: 4 }).avatar).toEqual({ avatar: "P", avatarVersion: 4 })
    expect(messageProfilePatches([{ thread: { id: "thread", participants: [{ id: "peer", avatar: null, avatarVersion: 4 }] } }]))
      .toEqual([{ id: "peer", avatar: { avatar: null, avatarVersion: 4 } }])
  })
})
