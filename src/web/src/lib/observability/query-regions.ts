"use client"

import { useQueryClient } from "@tanstack/react-query"
import { valueEvidence, type Evidence } from "./data-source"
import { useObservedRegion } from "./regions"
import type { Attributes } from "./schema"

type Resource = { data: unknown; isPending: boolean; isError?: boolean; dataUpdatedAt?: number }
export function useObservedQueryRegion(region: Attributes["region"], resource: Resource, count?: number, ready = true) {
  const client = useQueryClient()
  const evidence: Evidence = resource.data && typeof resource.data === "object" ? valueEvidence(client, resource.data) : { source: "unknown", version: "query_" + String(resource.dataUpdatedAt ?? 0), freshness: "unknown", count: resource.data == null ? 0 : 1 }
  useObservedRegion(region, ready && !resource.isPending && resource.data !== undefined, { ...evidence, ...(count === undefined ? {} : { count }) })
}
