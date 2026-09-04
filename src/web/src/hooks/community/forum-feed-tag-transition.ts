import { FORUM_ARCHIVE_TAG } from "@alook/shared"
import {
  hashKey,
  notifyManager,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query"
import type { ForumThread } from "@/lib/community/models/message"
import { communityKeys } from "@/lib/query-keys"

type ForumFeedThread = {
  id: string
  name: string | null
  creatorId: string | null
  messageCount: number | null
  parentMessageId: string | null
  lastMessageAt: string | null
  createdAt: string
  activityAt: string
}

type ForumIncludedMessage = {
  id: string
  channelId: string
  seq: number
  createdAt?: string
  content: string
  authorId: string
  authorName: string
  authorImage: string | null
  authorAvatarVersion: number
}

type ForumIncludedFirstMessage = { channelId: string; content: string }
type ForumIncludedTag = { messageId: string; tag: string }
type ForumIncludedParticipant = {
  channelId: string
  userId: string
  userName: string | null
  userImage: string | null
  userAvatarVersion: number
  participantCount?: number
}

export type ForumFeedPage = {
  serverId: string
  parentType: string
  threads: ForumFeedThread[]
  included: {
    parentMessages: ForumIncludedMessage[]
    firstMessages: ForumIncludedFirstMessage[]
    tags: ForumIncludedTag[]
    participants: ForumIncludedParticipant[]
  }
  hasMore: boolean
  nextCursor?: string
}

type FeedData = InfiniteData<ForumFeedPage>
type FeedThread = ForumFeedPage["threads"][number]
type ParentMessage = ForumFeedPage["included"]["parentMessages"][number]
type FirstMessage = ForumFeedPage["included"]["firstMessages"][number]
type IncludedTag = ForumFeedPage["included"]["tags"][number]
type Participant = ForumFeedPage["included"]["participants"][number]

type Indexed<T> = { index: number; value: T }

type PageSlice = {
  pageIndex: number
  pageParam: unknown
  thread: Indexed<FeedThread>
  parentMessages: Indexed<ParentMessage>[]
  firstMessages: Indexed<FirstMessage>[]
  tags: Indexed<IncludedTag>[]
  participants: Indexed<Participant>[]
}

type QuerySlice = {
  queryKey: QueryKey
  pages: PageSlice[]
}

type TransitionRecord = {
  generation: number
  forumChannelId: string
  threadId: string
  openerMessageId: string
  previousTags: string[]
  tags: string[]
  slices: QuerySlice[]
}

type TransitionOwner = {
  nextGeneration: number
  current: Map<string, TransitionRecord>
}

export type ForumFeedTagTransitionToken = Pick<
  TransitionRecord,
  "generation" | "forumChannelId" | "threadId" | "openerMessageId"
>

const owners = new WeakMap<QueryClient, TransitionOwner>()

function transitionKey(forumChannelId: string, threadId: string) {
  return hashKey([forumChannelId, threadId])
}

function getOwner(queryClient: QueryClient) {
  let owner = owners.get(queryClient)
  if (!owner) {
    owner = { nextGeneration: 0, current: new Map() }
    owners.set(queryClient, owner)
  }
  return owner
}

function getCurrent(
  queryClient: QueryClient,
  forumChannelId: string,
  threadId: string,
) {
  return owners.get(queryClient)?.current.get(transitionKey(forumChannelId, threadId))
}

function normalizedTags(tags: readonly string[]) {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))]
}

function includesArchived(tags: readonly string[]) {
  return tags.includes(FORUM_ARCHIVE_TAG)
}

function sameTags(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((tag) => b.includes(tag))
}

export function forumFeedMatchesTags(filter: string | null, tags: readonly string[]) {
  const archived = includesArchived(tags)
  if (filter === FORUM_ARCHIVE_TAG) return archived
  if (archived) return false
  return filter === null || tags.includes(filter)
}

function startsWithQueryKey(queryKey: QueryKey, prefix: QueryKey) {
  return prefix.length <= queryKey.length
    && hashKey(queryKey.slice(0, prefix.length)) === hashKey(prefix)
}

function forumFeedFilter(queryKey: QueryKey, forumChannelId: string) {
  const prefix = communityKeys.forumFeeds(forumChannelId)
  if (!startsWithQueryKey(queryKey, prefix) || queryKey.length !== prefix.length + 1) {
    return undefined
  }
  const filter = queryKey[prefix.length]
  return filter === null || typeof filter === "string" ? filter : undefined
}

function indexed<T>(values: readonly T[], predicate: (value: T) => boolean) {
  const result: Indexed<T>[] = []
  values.forEach((value, index) => {
    if (predicate(value)) result.push({ index, value })
  })
  return result
}

function validThreadOpener(page: ForumFeedPage, thread: FeedThread, openerMessageId: string) {
  return thread.parentMessageId === openerMessageId
    && page.included.parentMessages.some((message) => message.id === openerMessageId)
}

function extractPageSlice(
  page: ForumFeedPage,
  pageIndex: number,
  pageParam: unknown,
  threadId: string,
  openerMessageId: string,
): PageSlice | null {
  const threadIndex = page.threads.findIndex((thread) => thread.id === threadId)
  if (threadIndex < 0) return null
  const thread = page.threads[threadIndex]!
  if (!validThreadOpener(page, thread, openerMessageId)) return null
  return {
    pageIndex,
    pageParam,
    thread: { index: threadIndex, value: thread },
    parentMessages: indexed(
      page.included.parentMessages,
      (message) => message.id === openerMessageId,
    ),
    firstMessages: indexed(
      page.included.firstMessages,
      (message) => message.channelId === threadId,
    ),
    tags: indexed(
      page.included.tags,
      (tag) => tag.messageId === openerMessageId,
    ),
    participants: indexed(
      page.included.participants,
      (participant) => participant.channelId === threadId,
    ),
  }
}

function extractQuerySlice(
  queryKey: QueryKey,
  data: FeedData,
  threadId: string,
  openerMessageId: string,
) {
  const pages = data.pages.flatMap((page, pageIndex) => {
    const slice = extractPageSlice(
      page,
      pageIndex,
      data.pageParams[pageIndex] ?? null,
      threadId,
      openerMessageId,
    )
    return slice ? [slice] : []
  })
  return pages.length > 0 ? { queryKey, pages } : null
}

function removeForumPostFromFeedByIdentity(
  data: FeedData | undefined,
  childChannelId: string,
  openerMessageId: string,
  matches: (thread: FeedThread) => boolean,
): FeedData | undefined {
  if (!data) return data
  let touched = false
  const pages = data.pages.map((page) => {
    if (!page.threads.some(matches)) return page
    touched = true
    return {
      ...page,
      threads: page.threads.filter((thread) => !matches(thread)),
      included: {
        parentMessages: page.included.parentMessages.filter(
          (message) => message.id !== openerMessageId,
        ),
        firstMessages: page.included.firstMessages.filter(
          (message) => message.channelId !== childChannelId,
        ),
        tags: page.included.tags.filter(
          (tag) => tag.messageId !== openerMessageId,
        ),
        participants: page.included.participants.filter(
          (participant) => participant.channelId !== childChannelId,
        ),
      },
    }
  })
  return touched ? { ...data, pages } : data
}

/** Remove a post unit by either canonical identity for the delete path. */
export function removeForumPostFromFeed(
  data: FeedData | undefined,
  childChannelId: string,
  openerMessageId: string,
): FeedData | undefined {
  return removeForumPostFromFeedByIdentity(
    data,
    childChannelId,
    openerMessageId,
    (thread) => thread.id === childChannelId || thread.parentMessageId === openerMessageId,
  )
}

function removeExactForumPostFromFeed(
  data: FeedData | undefined,
  childChannelId: string,
  openerMessageId: string,
) {
  return removeForumPostFromFeedByIdentity(
    data,
    childChannelId,
    openerMessageId,
    (thread) => thread.id === childChannelId && thread.parentMessageId === openerMessageId,
  )
}

function insertAt<T>(values: readonly T[], additions: readonly Indexed<T>[]) {
  const result = [...values]
  for (const addition of [...additions].sort((a, b) => a.index - b.index)) {
    result.splice(Math.min(addition.index, result.length), 0, addition.value)
  }
  return result
}

function mergeUniqueAt<T>(
  values: readonly T[],
  additions: readonly Indexed<T>[],
  identity: (value: T) => string,
) {
  const existing = new Set(values.map(identity))
  return insertAt(values, additions.filter(({ value }) => !existing.has(identity(value))))
}

function matchingPageIndex(data: FeedData, slice: PageSlice) {
  if (hashKey([data.pageParams[slice.pageIndex] ?? null]) === hashKey([slice.pageParam])) {
    return slice.pageIndex
  }
  return data.pageParams.findIndex((pageParam) => (
    hashKey([pageParam ?? null]) === hashKey([slice.pageParam])
  ))
}

function mergePageSlice(
  data: FeedData | undefined,
  slice: PageSlice,
  threadId: string,
  openerMessageId: string,
) {
  if (!data) return data
  const existing = data.pages.flatMap((page) => page.threads)
    .find((thread) => thread.id === threadId || thread.parentMessageId === openerMessageId)
  if (existing) return data
  const pageIndex = matchingPageIndex(data, slice)
  if (pageIndex < 0 || !slice.parentMessages.some(({ value }) => value.id === openerMessageId)) {
    return data
  }
  const page = data.pages[pageIndex]!
  const pages = [...data.pages]
  pages[pageIndex] = {
    ...page,
    threads: insertAt(page.threads, [slice.thread]),
    included: {
      parentMessages: mergeUniqueAt(
        page.included.parentMessages,
        slice.parentMessages,
        (message) => message.id,
      ),
      firstMessages: mergeUniqueAt(
        page.included.firstMessages,
        slice.firstMessages,
        (message) => message.channelId,
      ),
      tags: mergeUniqueAt(
        page.included.tags,
        slice.tags,
        (tag) => `${tag.messageId}\u0000${tag.tag}`,
      ),
      participants: mergeUniqueAt(
        page.included.participants,
        slice.participants,
        (participant) => `${participant.channelId}\u0000${participant.userId}`,
      ),
    },
  }
  return { ...data, pages }
}

function patchTagsForExistingPost(
  data: FeedData | undefined,
  threadId: string,
  openerMessageId: string,
  tags: readonly string[],
) {
  if (!data) return data
  let touched = false
  const pages = data.pages.map((page) => {
    const thread = page.threads.find((candidate) => candidate.id === threadId)
    if (!thread || !validThreadOpener(page, thread, openerMessageId)) return page
    touched = true
    const priorIndexes = page.included.tags.flatMap((tag, index) => (
      tag.messageId === openerMessageId ? [index] : []
    ))
    const insertionIndex = priorIndexes[0] ?? page.included.tags.length
    const withoutTarget = page.included.tags.filter((tag) => tag.messageId !== openerMessageId)
    const nextRows = tags.map((tag, index) => ({
      index: insertionIndex + index,
      value: { messageId: openerMessageId, tag },
    }))
    return {
      ...page,
      included: {
        ...page.included,
        tags: insertAt(withoutTarget, nextRows),
      },
    }
  })
  return touched ? { ...data, pages } : data
}

function cachedTags(page: ForumFeedPage, openerMessageId: string) {
  return page.included.tags
    .filter((tag) => tag.messageId === openerMessageId)
    .map((tag) => tag.tag)
}

function resolveWsOpener(
  queryClient: QueryClient,
  forumChannelId: string,
  threadId: string,
) {
  const active = getCurrent(queryClient, forumChannelId, threadId)
  const openers = new Set<string>()
  let invalid = false
  for (const [, data] of queryClient.getQueriesData<FeedData>({
    queryKey: communityKeys.forumFeeds(forumChannelId),
  })) {
    for (const page of data?.pages ?? []) {
      const thread = page.threads.find((candidate) => candidate.id === threadId)
      if (!thread) continue
      const opener = thread.parentMessageId
      if (!opener || !validThreadOpener(page, thread, opener)) {
        invalid = true
        continue
      }
      openers.add(opener)
    }
  }
  if (active) {
    if (invalid || [...openers].some((opener) => opener !== active.openerMessageId)) return null
    return active.openerMessageId
  }
  if (invalid || openers.size !== 1) return null
  return [...openers][0]!
}

function projectTags(
  queryClient: QueryClient,
  input: {
    forumChannelId: string
    threadId: string
    openerMessageId: string
    tags: readonly string[]
  },
  source: "local" | "ws",
) {
  const tags = normalizedTags(input.tags)
  for (const [queryKey, data] of queryClient.getQueriesData<FeedData>({
    queryKey: communityKeys.forumFeeds(input.forumChannelId),
  })) {
    const filter = forumFeedFilter(queryKey, input.forumChannelId)
    if (filter === undefined || !data) continue
    const page = data.pages.find((candidate) => candidate.threads.some((thread) => (
      thread.id === input.threadId && thread.parentMessageId === input.openerMessageId
    )))
    if (!page) continue
    if (source === "ws" && includesArchived(cachedTags(page, input.openerMessageId)) === includesArchived(tags)) {
      continue
    }
    queryClient.setQueryData<FeedData>(queryKey, (current) => (
      forumFeedMatchesTags(filter, tags)
        ? patchTagsForExistingPost(current, input.threadId, input.openerMessageId, tags)
        : removeExactForumPostFromFeed(current, input.threadId, input.openerMessageId)
    ))
  }
  return tags
}

export function beginForumFeedTagTransition(
  queryClient: QueryClient,
  input: {
    forumChannelId: string
    threadId: string
    openerMessageId: string
    previousTags: readonly string[]
    tags: readonly string[]
  },
): ForumFeedTagTransitionToken | null {
  const previousTags = normalizedTags(input.previousTags)
  const tags = normalizedTags(input.tags)
  if (includesArchived(previousTags) === includesArchived(tags)) return null
  const owner = getOwner(queryClient)
  const key = transitionKey(input.forumChannelId, input.threadId)
  const prior = owner.current.get(key)
  const inheritedSlices = prior
    && prior.openerMessageId === input.openerMessageId
    && sameTags(prior.previousTags, previousTags)
    && sameTags(prior.tags, tags)
    ? prior.slices
    : []
  const record: TransitionRecord = {
    generation: ++owner.nextGeneration,
    forumChannelId: input.forumChannelId,
    threadId: input.threadId,
    openerMessageId: input.openerMessageId,
    previousTags,
    tags,
    slices: [...inheritedSlices],
  }
  owner.current.set(key, record)
  for (const [queryKey, data] of queryClient.getQueriesData<FeedData>({
    queryKey: communityKeys.forumFeeds(input.forumChannelId),
  })) {
    const filter = forumFeedFilter(queryKey, input.forumChannelId)
    if (filter === undefined || !data || forumFeedMatchesTags(filter, tags)) continue
    const slice = extractQuerySlice(queryKey, data, input.threadId, input.openerMessageId)
    if (!slice) continue
    if (!record.slices.some((saved) => hashKey(saved.queryKey) === hashKey(queryKey))) {
      record.slices.push(slice)
    }
    queryClient.setQueryData<FeedData>(queryKey, (current) => removeExactForumPostFromFeed(
      current,
      input.threadId,
      input.openerMessageId,
    ))
  }
  return {
    generation: record.generation,
    forumChannelId: record.forumChannelId,
    threadId: record.threadId,
    openerMessageId: record.openerMessageId,
  }
}

function isCurrent(record: TransitionRecord | undefined, token: ForumFeedTagTransitionToken) {
  return record?.generation === token.generation
    && record.openerMessageId === token.openerMessageId
}

export function commitForumFeedTagTransition(
  queryClient: QueryClient,
  token: ForumFeedTagTransitionToken,
  tags: readonly string[],
) {
  const owner = getOwner(queryClient)
  const key = transitionKey(token.forumChannelId, token.threadId)
  const record = owner.current.get(key)
  if (!record || !isCurrent(record, token)) return
  notifyManager.batch(() => {
    record.tags = normalizedTags(tags)
    const authoritativeTags = projectTags(queryClient, {
      forumChannelId: token.forumChannelId,
      threadId: token.threadId,
      openerMessageId: token.openerMessageId,
      tags: record.tags,
    }, "local")
    for (const querySlice of record.slices) {
      const filter = forumFeedFilter(querySlice.queryKey, token.forumChannelId)
      if (filter === undefined || !forumFeedMatchesTags(filter, authoritativeTags)) continue
      queryClient.setQueryData<FeedData>(querySlice.queryKey, (current) => {
        let next = current
        for (const slice of querySlice.pages) {
          next = mergePageSlice(next, slice, token.threadId, token.openerMessageId)
        }
        return patchTagsForExistingPost(
          next,
          token.threadId,
          token.openerMessageId,
          authoritativeTags,
        )
      })
    }
    owner.current.delete(key)
  })
}

export function rollbackForumFeedTagTransition(
  queryClient: QueryClient,
  token: ForumFeedTagTransitionToken,
) {
  const owner = getOwner(queryClient)
  const key = transitionKey(token.forumChannelId, token.threadId)
  const record = owner.current.get(key)
  if (!record || !isCurrent(record, token)) return false
  notifyManager.batch(() => {
    record.tags = record.previousTags
    for (const querySlice of record.slices) {
      queryClient.setQueryData<FeedData>(querySlice.queryKey, (current) => {
        let next = current
        for (const slice of querySlice.pages) {
          next = mergePageSlice(next, slice, token.threadId, token.openerMessageId)
        }
        return next
      })
    }
    owner.current.delete(key)
  })
  return true
}

export function projectForumFeedWsTags(
  queryClient: QueryClient,
  input: { forumChannelId: string; threadId: string; tags: readonly string[] },
) {
  const openerMessageId = resolveWsOpener(queryClient, input.forumChannelId, input.threadId)
  if (!openerMessageId) return false
  projectTags(queryClient, { ...input, openerMessageId }, "ws")
  return true
}

export function projectForumThreadsThroughActiveTagTransitions(
  queryClient: QueryClient,
  forumChannelId: string,
  filter: string | null,
  posts: readonly ForumThread[],
) {
  return posts.filter((post) => {
    const record = getCurrent(queryClient, forumChannelId, post.id)
    if (!record || record.openerMessageId !== post.openerMessageId) return true
    return forumFeedMatchesTags(filter, record.tags)
  })
}

export function hasForumFeedTagTransition(
  queryClient: QueryClient,
  token: ForumFeedTagTransitionToken,
) {
  return isCurrent(
    getCurrent(queryClient, token.forumChannelId, token.threadId),
    token,
  )
}
