"use client"

import { useNativeMutationFacade } from "@/hooks/use-native-mutation-facade"

import { useCallback } from "react"

import { useCommunityMutationOrigin } from "../community-origin"
import { useCommunityViewSource } from "../use-community-view-source"
import {
  hashKey,
  useMutation,
  useQueryClient,
  type Query,
  type QueryKey,
} from "@tanstack/react-query"
import { apiFetch } from "@/lib/api/client"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { collectChannelScopeIds } from "../community-ws/scope-eviction"
import { communityKeys } from "@/lib/query-keys"
import type { UploadedAttachment } from "@/hooks/community/mutations/uploads"
import type { MentionType } from "@alook/shared"
import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import {
  applyForumPostUnitClientEffects,
  type ForumPostUnitIdentity,
} from "@/hooks/community/community-ws/channel-scope-projection"
import { beginCommunityCommandRevision, publishCommunityDeletedForumPost, publishCommunityCreatedChannel, publishCommunityForumTags, publishCommunityMessages } from "@/lib/community-db/sync"
import { projectPostedMessage, type PostedMessage } from "@/lib/community/message-wire"
import { reconcileForumSidebarArchiveTag } from "../use-forum-sidebar-threads"

export type CreateForumThreadArgs = {
  assertActive?: (() => void) & { signal: AbortSignal }
  nonce: string
  channelId: string
  name: string
  content: string
  // Pre-uploaded pending attachments — the client uploads via `useUploadFile`
  // (creating pending rows) before firing this mutation and passes the
  // descriptors here; only their `id`s reach the server (reserve-by-id,
  // route/disc step 2b), which links them onto the post's first message.
  attachments?: UploadedAttachment[]
  // Propagated to the first message so `@everyone` audience broadcast
  // fires end-to-end.
  mentionType?: MentionType
}
export type CreateForumThreadResult = { threadId: string }

export function useCreateForumThread() {
  const origin = useCommunityMutationOrigin()
  const queryClient = useQueryClient()
  type Intent = CreateForumThreadArgs & { original: ReturnType<typeof origin.begin>["token"]; resources: Query[] }
  const native = useMutation<CreateForumThreadResult, Error, Intent>({ meta: { observabilityAction: "forum.thread.create" },
    mutationFn: async ({ nonce, channelId, name, content, attachments, mentionType, original: token, resources, assertActive }) => {
      const assert = () => { origin.assert(token); assertActive?.() }
      assert()
      await origin.registry?.ready
      assert()
      await Promise.all([origin.registry!.collections.channels.preload(), origin.registry!.collections.messages.preload(), origin.registry!.collections.channelMemberships.preload()])
      assert()
      const attachmentIds = attachments?.map((a) => a.id)
      const structure = await origin.request<CreateForumThreadResult & { message: PostedMessage }>(token,
        `/api/community/channels/${channelId}/messages`,
        {
          method: "POST", signal: assertActive?.signal, assertActive,
          body: JSON.stringify({ content: name, attachments: attachmentIds, mentionType, nonce: `${nonce}:opener` }),
        },
      )
      assert()
      const parent = origin.registry!.collections.channels.get(channelId)
      if (parent && structure.message) {
        publishCommunityMessages(queryClient, { channelId, messages: [projectPostedMessage(structure.message, `${nonce}:opener`)], proof: { token, signal: assertActive?.signal } })
        publishCommunityCreatedChannel(queryClient, { id: structure.threadId, serverId: parent.serverId, categoryId: null, name, type: "thread", parentChannelId: channelId, parentMessageId: structure.message.id, creatorId: structure.message.authorId, position: 0, archived: false, muted: false, unread: false, tags: [], pending: false, createdAt: structure.message.createdAt, lastMessageAt: structure.message.createdAt, messageCount: 0 }, { token, signal: assertActive?.signal })
      }
      assert()
      const reply = await origin.request<{ message: PostedMessage }>(token, `/api/community/channels/${structure.threadId}/messages`, {
        method: "POST", signal: assertActive?.signal, assertActive,
        body: JSON.stringify({ content, attachments: attachmentIds, nonce: `${nonce}:reply` }),
      })
      assert()
      if (reply.message) publishCommunityMessages(queryClient, { channelId: structure.threadId, messages: [projectPostedMessage(reply.message, `${nonce}:reply`)], proof: { token, signal: assertActive?.signal } })
      for (const query of resources) if (queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined)
      return structure
    },
  })
  const capture = useCallback((input: CreateForumThreadArgs): Intent => { input.assertActive?.(); return { ...input, original: origin.begin().token, resources: [communityKeys.channelMessages(input.channelId), communityKeys.threads(input.channelId)].flatMap((queryKey) => queryClient.getQueryCache().findAll({ queryKey })) } }, [origin, queryClient])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export type UpdatePostTagsArgs = {
  assertActive?: (() => void) & { signal: AbortSignal }
  serverId: string
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post/thread card being patched in cache.
  threadId: string
  // Tags are a resource of the forum opener message, never of the child thread.
  openerMessageId: string
  previousTags: string[]
  tags: string[]
}

export function useUpdatePostTags() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient(), source = useCommunityViewSource("forum-tag-command")
  type Intent = UpdatePostTagsArgs & { original: ReturnType<typeof origin.begin>["token"]; view: ReturnType<typeof source.capture>; resources: Query[] }
  const currentCommand = useCallback((args: Intent) => {
    const mutations = queryClient.getMutationCache().findAll({ mutationKey: ["community", "forum-tag-command"], exact: true })
    const original = mutations.find((mutation) => mutation.state.variables === args)
    return !!original && !mutations.some((mutation) => {
      const next = mutation.state.variables as Intent | undefined
      return mutation.mutationId > original.mutationId && next?.original.registry === args.original.registry
        && next.serverId === args.serverId && next.forumChannelId === args.forumChannelId
        && next.threadId === args.threadId && next.openerMessageId === args.openerMessageId
    })
  }, [queryClient])
  const native = useMutation<{ tags: string[] }, Error, Intent>({ meta: { observabilityAction: "forum.tags.update" },
    mutationKey: ["community", "forum-tag-command"], gcTime: 0,
    mutationFn: async (args) => {
      const registry = origin.registry!, assert = () => { origin.assert(args.original); args.view(); args.assertActive?.() }
      const signal = args.assertActive?.signal ? AbortSignal.any([args.view.signal, args.assertActive.signal]) : args.view.signal
      assert()
      await registry.ready
      assert()
      await registry.collections.channels.preload()
      assert()
      const resources = new Set(args.resources)
      await queryClient.cancelQueries({ queryKey: communityKeys.forumFeeds(args.forumChannelId), predicate: (query) => resources.has(query) })
      assert()
      const token = beginCommunityCommandRevision(queryClient, args.original)
      const previousArchived = (registry.collections.channels.get(args.threadId)?.tags ?? args.previousTags).includes(FORUM_ARCHIVE_TAG)
      const tags = [...new Set(args.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
      let result = { tags }
      const persist = async () => {
        result = await origin.request<{ tags: string[] }>(token, `/api/community/messages/${args.openerMessageId}/tags`, { method: "PUT", signal, assertActive: assert, body: JSON.stringify({ tags }) })
        assert()
        result = { tags: [...new Set(result.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))] }
        const child = registry.collections.channels.get(args.threadId)
        if (currentCommand(args) && child?.serverId === args.serverId && child.parentChannelId === args.forumChannelId && child.parentMessageId === args.openerMessageId
          && publishCommunityForumTags(queryClient, args.threadId, result.tags, { token, signal }) && previousArchived !== result.tags.includes(FORUM_ARCHIVE_TAG)) {
          await reconcileForumSidebarArchiveTag(queryClient, args.serverId, args.threadId, result.tags.includes(FORUM_ARCHIVE_TAG))
          assert()
        }
      }
      const transaction = registry.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      transaction.mutate(() => { const thread = registry.collections.channels.get(args.threadId); if (thread?.parentMessageId === args.openerMessageId) registry.collections.channels.update(args.threadId, (row) => { row.tags = tags }) })
      try { if (transaction.mutations.length) await transaction.commit(); else await persist() } catch (error) { assert(); throw error }
      assert()
      await queryClient.cancelQueries({ queryKey: communityKeys.forumTags(args.forumChannelId), exact: true, predicate: (query) => resources.has(query) })
      assert()
      for (const query of args.resources) if (queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined)
      return result
    },
  })
  const capture = useCallback((input: UpdatePostTagsArgs): Intent => { input.assertActive?.(); const view = source.capture(); view(); return { ...input, view, original: origin.begin().token, resources: [communityKeys.channelMessages(input.forumChannelId), communityKeys.forumFeeds(input.forumChannelId), communityKeys.threads(input.forumChannelId), communityKeys.forumTags(input.forumChannelId)].flatMap((queryKey) => queryClient.getQueryCache().findAll({ queryKey })) } }, [origin, queryClient, source])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.view(); args.assertActive?.(); if (!currentCommand(args)) throw new DOMException("Superseded forum tag command", "AbortError") }, [origin, currentCommand])
  return useNativeMutationFacade(native, capture, assertCurrent)
}

export type DeleteForumThreadArgs = {
  assertActive?: (() => void) & { signal: AbortSignal }
  serverId: string
  // The parent forum channel — the cache key the post list lives under.
  forumChannelId: string
  // The post channel being deleted.
  threadId: string
  // Canonical post identity addressed by the server DELETE route.
  openerMessageId: string
}

function toPostUnit(args: DeleteForumThreadArgs): ForumPostUnitIdentity {
  return {
    serverId: args.serverId,
    forumChannelId: args.forumChannelId,
    childChannelId: args.threadId,
    openerMessageId: args.openerMessageId,
  }
}

function startsWithQueryKey(queryKey: QueryKey, prefix: QueryKey) {
  return prefix.length <= queryKey.length
    && hashKey(queryKey.slice(0, prefix.length)) === hashKey(prefix)
}

function isForumPostUnitQuery(query: Query, unit: ForumPostUnitIdentity) {
  const key = query.queryKey
  const exactKeys: QueryKey[] = [
    communityKeys.server(unit.serverId),
    communityKeys.forumSidebarThreads(unit.serverId),
    communityKeys.channelMeta(unit.serverId, unit.childChannelId),
    communityKeys.message(unit.openerMessageId),
  ]
  return exactKeys.some((candidate) => hashKey(candidate) === hashKey(key)) || [
    communityKeys.channelMessages(unit.forumChannelId),
    communityKeys.forumFeeds(unit.forumChannelId),
    communityKeys.channelMessages(unit.childChannelId),
    communityKeys.pins(unit.childChannelId),
    communityKeys.threads(unit.childChannelId),
  ].some((prefix) => startsWithQueryKey(key, prefix))
}

export function useDeleteForumThread() {
  const origin = useCommunityMutationOrigin(), queryClient = useQueryClient()
  const source = useCommunityViewSource("forum-post-delete")
  type Intent = DeleteForumThreadArgs & { original: ReturnType<typeof origin.begin>["token"]; view: ReturnType<typeof source.capture>; resources: Query[] }
  const native = useMutation<void, Error, Intent>({ meta: { observabilityAction: "forum.thread.delete" },
    mutationKey: ["community", "forum-post-delete"], gcTime: 0,
    scope: { id: "community-forum-post-commands" },
    mutationFn: async (args) => {
      const registry = origin.registry, unit = toPostUnit(args)
      const assert = () => { origin.assert(args.original); args.view(); args.assertActive?.() }
      assert()
      await registry?.ready
      assert()
      await registry!.preload()
      assert()
      await queryClient.cancelQueries({ predicate: (query) => args.resources.includes(query) && isForumPostUnitQuery(query, unit) })
      assert()
      const token = beginCommunityCommandRevision(queryClient, args.original)
      const removed = collectChannelScopeIds(queryClient, unit.serverId, unit.childChannelId)
      const persist = async () => {
        assert()
        const controller = new AbortController()
        const assertOwner = () => origin.assertOwner(args.original)
        const subscription = registry!.runtime.lifecycle.subscribe(() => {
          try { assertOwner() } catch { controller.abort() }
        })
        try {
          await apiFetch(`/api/community/messages/${unit.openerMessageId}`, {
            method: "DELETE",
            ...communityRequestOptions(queryClient, token, controller.signal, assertOwner),
          })
          assertOwner()
          try { origin.assert(token) } catch { return }
          if (publishCommunityDeletedForumPost(queryClient, unit, { token, signal: controller.signal })) applyForumPostUnitClientEffects(queryClient, unit, { queries: new Set(args.resources), assertView: assert, canonical: false })
          for (const query of args.resources) if (queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query && [communityKeys.channelMessages(args.forumChannelId), communityKeys.threads(args.forumChannelId), communityKeys.forumTags(args.forumChannelId), communityKeys.server(args.serverId)].some((key) => startsWithQueryKey(query.queryKey, key))) void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false }).catch(() => undefined)
        } catch (error) { assertOwner(); throw error }
        finally { subscription.unsubscribe() }
      }
      const transaction = registry!.dbClient.createTransaction({ autoCommit: false, mutationFn: persist })
      transaction.mutate(() => {
        const c = registry!.collections
        for (const row of c.channels.values()) if (removed.has(row.id)) c.channels.delete(row.id)
        for (const row of c.channelMemberships.values()) if (removed.has(row.channelId)) c.channelMemberships.delete(row.id)
        for (const row of c.messages.values()) if (removed.has(row.channelId) || row.id === unit.openerMessageId) c.messages.delete(row.id)
        for (const row of c.readStates.values()) if (removed.has(row.channelId)) c.readStates.delete(row.channelId)
        for (const row of c.attentionScopes.values()) if (removed.has(row.channelId)) c.attentionScopes.delete(row.scopeId)
        for (const row of c.attentionItems.values()) if (row.messageId === unit.openerMessageId || row.childChannelId === unit.childChannelId || row.scopeId && removed.has(row.scopeId)) c.attentionItems.delete(row.id)
        for (const row of c.notificationSettings.values()) if (row.channelId && removed.has(row.channelId)) c.notificationSettings.delete(row.id)
      })
      try { if (transaction.mutations.length) await transaction.commit(); else await persist() } catch (error) { origin.assertOwner(args.original); throw error }
    },
  })
  const capture = useCallback((input: DeleteForumThreadArgs): Intent => { input.assertActive?.(); const view = source.capture(); view(); return { ...input, view, original: origin.begin().token, resources: queryClient.getQueryCache().findAll() } }, [origin, queryClient, source])
  const assertCurrent = useCallback((args: Intent) => { origin.assert(args.original); args.view(); args.assertActive?.() }, [origin])
  return useNativeMutationFacade(native, capture, assertCurrent)
}
