"use client"

import { useQueryClient } from "@tanstack/react-query"
import { BotCreationPayloadSchema, type BotCreationPayload } from "@alook/shared"
import { useCommunityCommandMutation } from "../use-community-command-mutation"
import { useCommunityMutationOrigin } from "../community-origin"
import { publishCommunityMessageFields } from "@/lib/community-db/sync"
import { invalidateBotSurfaces } from "../use-bots"

type DecisionInput = {
  requestId: string
  messageId: string
  decision: "approve" | "decline"
}

export function useBotCreationDecision() {
  const origin = useCommunityMutationOrigin()
  const client = useQueryClient()
  return useCommunityCommandMutation<{ botCreation: BotCreationPayload }, Error, DecisionInput>(origin, {
    mutationKey: ["community", "bot-creation", "decision"],
    meta: { observabilityAction: "bot.creation.decision" },
    retry: false,
    mutationFn: async ({ requestId, messageId, decision, original }) => {
      const data = await origin.request<{ botCreation: BotCreationPayload }>(original,
        `/api/community/bots/creation-requests/${encodeURIComponent(requestId)}`,
        { method: "PATCH", body: JSON.stringify({ decision }) },
      )
      const botCreation = BotCreationPayloadSchema.parse(data.botCreation)
      if (botCreation.requestId !== requestId) throw new Error("The request changed. Reload this conversation before trying again.")
      origin.assert(original)
      publishCommunityMessageFields(client, messageId, { botCreation }, { token: original })
      return { botCreation }
    },
    onSuccess: ({ botCreation }, { resources }) => {
      if (botCreation.status === "approved") invalidateBotSurfaces(client, undefined, resources.filter(({ queryKey }) => queryKey[0] === "community" && ["bots", "friends", "dms"].includes(String(queryKey[1]))))
    },
  })
}
