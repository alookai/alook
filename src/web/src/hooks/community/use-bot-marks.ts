"use client"

import { captureCommunityLiveSnapshotToken } from "@/lib/community-db/sync"
import { communityRequestOptions } from "@/lib/community/account-cache-lifecycle"
import { useQuery } from "@tanstack/react-query"

import { apiFetch } from "@/lib/api/client"
import { ApiError } from "@/lib/errors"
import { communityKeys } from "@/lib/query-keys"
import type { Marked } from "@/lib/community/models/inbox"

type BotMarksResponse = { marked: Marked[] }

export function useBotMarks(botId: string | null | undefined) {
  const enabled = Boolean(botId)

  const query = useQuery<BotMarksResponse>({
    enabled,
    queryKey: botId ? communityKeys.botMarks(botId) : ["disabled-bot-marks"],
    queryFn: ({ client, signal }) => apiFetch<BotMarksResponse>(`/api/community/bots/${botId}/marks`, communityRequestOptions(client, captureCommunityLiveSnapshotToken(client), signal)),
    retry: (failureCount, error) =>
      !(error instanceof ApiError && error.status === 404) && failureCount < 1,
    refetchOnMount: "always",
  })

  return {
    marks: query.data?.marked ?? [],
    isLoading: query.isLoading,
    isError: query.isError,
    isNotFound: query.error instanceof ApiError && query.error.status === 404,
  }
}
