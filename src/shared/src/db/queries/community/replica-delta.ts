import type { CommunityReplicaFrontier } from "../../../community/replica";
import type { Database } from "../../index";
import { getReplicaScopeRevisions, listReplicaDeltaRows, type ReplicaDeltaRow } from "./replica-store";

export type ReplicaDeltaWindow =
  | { status: "ok"; rows: ReplicaDeltaRow[]; frontier: CommunityReplicaFrontier; hasMore: boolean }
  | { status: "rebootstrap"; scopes: CommunityReplicaFrontier[number]["scope"][] };

export async function readReplicaDeltaWindow(
  db: Database,
  from: CommunityReplicaFrontier,
  limit: number,
): Promise<ReplicaDeltaWindow> {
  const current = await getReplicaScopeRevisions(db, from.map((entry) => entry.scope));
  const currentByScope = new Map(current.map((entry) => [
    `${entry.scope.kind}:${entry.scope.id}`,
    entry.revision,
  ]));
  const invalid = from.filter((entry) => {
    const revision = currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0;
    return entry.revision > revision || (entry.scope.kind !== "channel" && entry.revision !== revision);
  }).map((entry) => entry.scope);
  if (invalid.length > 0) return { status: "rebootstrap", scopes: invalid };

  const rowsByScope: ReplicaDeltaRow[][] = [];
  for (const entry of from) {
    const currentRevision = currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0;
    if (entry.revision === currentRevision) continue;
    // `limit` counts causal batches, not individual scope deltas. Read the
    // same bounded prefix from every covered channel so a commit spanning a
    // thread and its parent can never be split at the response boundary.
    const scopeRows = await listReplicaDeltaRows(db, entry.scope, entry.revision, limit + 1);
    if (scopeRows[0]?.revision !== entry.revision + 1) {
      return { status: "rebootstrap", scopes: [entry.scope] };
    }
    for (let index = 1; index < scopeRows.length; index += 1) {
      if (scopeRows[index]!.revision !== scopeRows[index - 1]!.revision + 1) {
        return { status: "rebootstrap", scopes: [entry.scope] };
      }
    }
    rowsByScope.push(scopeRows);
  }

  const causalRows = new Map<string, ReplicaDeltaRow[]>();
  const causalOrder = new Map<string, { committedAt: string; causalId: string }>();
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const scopeRows of rowsByScope) {
    for (const row of scopeRows) {
      const grouped = causalRows.get(row.causalId) ?? [];
      grouped.push(row);
      causalRows.set(row.causalId, grouped);
      const existing = causalOrder.get(row.causalId);
      if (!existing || row.committedAt < existing.committedAt) {
        causalOrder.set(row.causalId, { committedAt: row.committedAt, causalId: row.causalId });
      }
      indegree.set(row.causalId, indegree.get(row.causalId) ?? 0);
    }
    for (let index = 1; index < scopeRows.length; index += 1) {
      const before = scopeRows[index - 1]!.causalId;
      const after = scopeRows[index]!.causalId;
      if (before === after) continue;
      const edges = outgoing.get(before) ?? new Set<string>();
      if (!edges.has(after)) {
        edges.add(after);
        outgoing.set(before, edges);
        indegree.set(after, (indegree.get(after) ?? 0) + 1);
      }
    }
  }

  const compareCausal = (left: string, right: string) => {
    const a = causalOrder.get(left)!;
    const b = causalOrder.get(right)!;
    return a.committedAt.localeCompare(b.committedAt) || a.causalId.localeCompare(b.causalId);
  };
  const ready = [...indegree]
    .filter(([, degree]) => degree === 0)
    .map(([causalId]) => causalId)
    .sort(compareCausal);
  const orderedCausalIds: string[] = [];
  while (ready.length > 0) {
    const causalId = ready.shift()!;
    orderedCausalIds.push(causalId);
    for (const next of outgoing.get(causalId) ?? []) {
      const degree = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, degree);
      if (degree === 0) {
        ready.push(next);
        ready.sort(compareCausal);
      }
    }
  }
  if (orderedCausalIds.length !== causalRows.size) {
    return { status: "rebootstrap", scopes: from.map((entry) => entry.scope) };
  }

  const selected = orderedCausalIds
    .slice(0, limit)
    .flatMap((causalId) => causalRows.get(causalId) ?? []);
  const frontier = from.map((entry) => {
    const last = selected
      .filter((row) => row.scopeKind === entry.scope.kind && row.scopeId === entry.scope.id)
      .at(-1);
    return { scope: entry.scope, revision: last?.revision ?? entry.revision };
  });
  const hasMore = frontier.some((entry) => (
    entry.revision < (currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0)
  ));
  return { status: "ok", rows: selected, frontier, hasMore };
}
