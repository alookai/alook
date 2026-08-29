import { QueryClient } from "@tanstack/react-query"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { communityKeys } from "@/lib/query-keys"
import type { MessagesPage, Msg } from "@/lib/community/models/message"
import {
  apiFetchProfiles,
  communityUserProfilePatch,
  loadAndSeedProfiles,
  messageProfilePatches,
  seedPersistedMessageProfiles,
} from "./profile-seed"
import { useCommunityWsStore } from "@/stores/community/ws"

const apiFetch = vi.hoisted(() => vi.fn())

vi.mock("@/lib/api/client", () => ({ apiFetch }))

function activate(viewerId = "viewer") {
  useCommunityWsStore.getState().activateProfileAccount(viewerId)
  return useCommunityWsStore.getState().beginProfileSnapshot()
}

function chat(overrides: Partial<Msg> = {}): Msg {
  return {
    id: "m1",
    type: "chat",
    content: "hello",
    ...overrides,
  }
}

beforeEach(() => {
  apiFetch.mockReset()
  useCommunityWsStore.getState().reset()
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
  it("seeds restored persisted messages without rewriting the raw Query payload", () => {
    const snapshot = activate()
    const queryClient = new QueryClient()
    const data = {
      pages: [{
        messages: [chat({
          authorId: "u1",
          authorName: "Persisted Alice",
          authorAvatar: "/persisted.png",
          authorAvatarVersion: 8,
        })],
        hasMore: false,
      } satisfies MessagesPage],
      pageParams: [{ mode: "newest" }],
    }
    queryClient.setQueryData(communityKeys.channelMessages("channel"), data)
    const rawBefore = queryClient.getQueryData(communityKeys.channelMessages("channel"))

    seedPersistedMessageProfiles(queryClient, snapshot)

    expect(queryClient.getQueryData(communityKeys.channelMessages("channel"))).toBe(rawBefore)
    expect(useCommunityWsStore.getState().profilesByUserId.get("u1")).toMatchObject({
      name: "Persisted Alice",
      avatar: "/persisted.png",
      avatarVersion: 8,
    })
  })

  it("returns the raw API object while seeding its typed profile projection", async () => {
    activate()
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
    expect(useCommunityWsStore.getState().profilesByUserId.get("u2")?.name).toBe("API Alice")
  })

  it("does not let a late request overwrite a newer authoritative group patch", async () => {
    activate()
    let resolve!: (value: { id: string; name: string }) => void
    const pending = new Promise<{ id: string; name: string }>((done) => { resolve = done })
    const resultPromise = loadAndSeedProfiles(
      () => pending,
      (data) => [{ id: data.id, identityAbout: { name: data.name } }],
    )

    const profiles = useCommunityWsStore.getState()
    profiles.patchProfiles(profiles.beginProfileSnapshot(), [{
      id: "u3",
      identityAbout: { name: "WS Alice" },
    }])
    const raw = { id: "u3", name: "Late API Alice" }
    resolve(raw)

    await expect(resultPromise).resolves.toBe(raw)
    expect(useCommunityWsStore.getState().profilesByUserId.get("u3")?.name).toBe("WS Alice")
  })
})
