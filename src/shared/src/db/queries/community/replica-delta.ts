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

  const rows: ReplicaDeltaRow[] = [];
  for (const entry of from) {
    const currentRevision = currentByScope.get(`${entry.scope.kind}:${entry.scope.id}`) ?? 0;
    if (entry.revision === currentRevision) continue;
    const remaining = limit + 1 - rows.length;
    if (remaining <= 0) break;
    const scopeRows = await listReplicaDeltaRows(db, entry.scope, entry.revision, remaining);
    if (scopeRows[0]?.revision !== entry.revision + 1) {
      return { status: "rebootstrap", scopes: [entry.scope] };
    }
    for (let index = 1; index < scopeRows.length; index += 1) {
      if (scopeRows[index]!.revision !== scopeRows[index - 1]!.revision + 1) {
        return { status: "rebootstrap", scopes: [entry.scope] };
      }
    }
    rows.push(...scopeRows);
  }

  const selected = rows.slice(0, limit);
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
