import { z } from "zod";
import { MAX_FOLDER_NAME_LENGTH } from "./constants/community";

export const MAX_SERVER_RAIL_COMMANDS = 3;
export const MAX_SERVER_RAIL_FOLDERS = 10;
export const MAX_SERVER_RAIL_REQUEST_BYTES = 1_000_000;
export const SERVER_RAIL_SNAPSHOT_STATEMENTS = 4;
export const SERVER_RAIL_MAX_WRITE_STATEMENTS = 11;

const idSchema = z.string().trim().min(1);
const idsSchema = z.array(idSchema);

export const serverRailEntrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("server"), id: idSchema }),
  z.strictObject({ kind: z.literal("folder"), id: idSchema }),
]);
export type ServerRailEntry = z.infer<typeof serverRailEntrySchema>;
const reorderTopLevelSchema = z.strictObject({
  kind: z.literal("reorder-top-level"),
  entries: z.array(serverRailEntrySchema),
});

const replaceFolderItemsSchema = z.strictObject({
  kind: z.literal("replace-folder-items"),
  folderId: idSchema,
  serverIds: idsSchema.min(1),
});
const deleteFolderSchema = z.strictObject({
  kind: z.literal("delete-folder"),
  folderId: idSchema,
});
const createFolderSchema = z.strictObject({
  kind: z.literal("create-folder"),
  clientId: idSchema,
  name: z.string().trim().min(1).max(MAX_FOLDER_NAME_LENGTH),
  serverIds: idsSchema.min(1),
});

export const serverRailCommandSchema = z.discriminatedUnion("kind", [
  reorderTopLevelSchema,
  replaceFolderItemsSchema,
  deleteFolderSchema,
  createFolderSchema,
]);

export const serverRailCommitRequestSchema = z.strictObject({
  commands: z.array(serverRailCommandSchema).min(1).max(MAX_SERVER_RAIL_COMMANDS),
});

export type ServerRailCommand = z.infer<typeof serverRailCommandSchema>;
export type ServerRailCommitRequest = z.infer<typeof serverRailCommitRequestSchema>;

export type ServerRailCommitResponse = {
  createdFolderIds: Record<string, string>;
};

export type ServerRailFolderState = {
  id: string;
  name: string;
  serverIds: string[];
};

export type ServerRailState = {
  topOrder?: ServerRailEntry[];
  serverIds: string[];
  folderIds: string[];
  folders: Record<string, ServerRailFolderState>;
};

export type ServerRailProjection = {
  before: ServerRailState;
  after: ServerRailState;
  affectedFolderIds: string[];
  movedServerIds: string[];
  createdFolders: ServerRailFolderState[];
  deletedFolderIds: string[];
  reorderTopLevel: boolean;
  createdFolderIds: Record<string, string>;
};

export type ServerRailProjectionResult =
  | { ok: true; value: ServerRailProjection }
  | { ok: false; error: string; status: 400 | 404 };

function cloneState(state: ServerRailState): ServerRailState {
  return {
    ...(state.topOrder ? { topOrder: state.topOrder.map((entry) => ({ ...entry })) } : {}),
    serverIds: [...state.serverIds],
    folderIds: [...state.folderIds],
    folders: Object.fromEntries(
      Object.entries(state.folders).map(([id, folder]) => [
        id,
        { ...folder, serverIds: [...folder.serverIds] },
      ]),
    ),
  };
}

export function serverRailTopOrder(state: ServerRailState): ServerRailEntry[] {
  const claimed = new Set(state.folderIds.flatMap((id) => state.folders[id]?.serverIds ?? []));
  const entries: ServerRailEntry[] = [
    ...state.serverIds.filter((id) => !claimed.has(id)).map((id) => ({ kind: "server" as const, id })),
    ...state.folderIds.filter((id) => !!state.folders[id]?.serverIds.length).map((id) => ({ kind: "folder" as const, id })),
  ];
  const allowed = new Set(entries.map((entry) => `${entry.kind}:${entry.id}`));
  const seen = new Set<string>();
  return [...(state.topOrder ?? []), ...entries].filter((entry) => {
    const key = `${entry.kind}:${entry.id}`;
    if (!allowed.has(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function serverRailServerIds(state: ServerRailState): string[] {
  return serverRailTopOrder(state).flatMap((entry) =>
    entry.kind === "server" ? [entry.id] : state.folders[entry.id]?.serverIds ?? [],
  );
}

export function sortServerRailRows<T extends { id: string }>(state: ServerRailState, rows: T[]): T[] {
  const ranks = new Map(serverRailServerIds(state).map((id, index) => [id, index]));
  return rows.slice().sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}

function hasDuplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length
    && right.every((value) => left.includes(value));
}

function parentByServer(state: ServerRailState): Map<string, string | null> {
  const parents = new Map<string, string | null>(
    state.serverIds.map((serverId) => [serverId, null]),
  );
  for (const folderId of state.folderIds) {
    for (const serverId of state.folders[folderId]?.serverIds ?? []) {
      parents.set(serverId, folderId);
    }
  }
  return parents;
}

function validateFinalState(
  state: ServerRailState,
  options: { allowFolderOverflow?: boolean } = {},
): string | null {
  if (hasDuplicates(state.serverIds)) return "serverIds must be unique";
  if (hasDuplicates(state.folderIds)) return "folderIds must be unique";
  if (!options.allowFolderOverflow && state.folderIds.length > MAX_SERVER_RAIL_FOLDERS) {
    return "folder limit reached";
  }
  const membershipIds = new Set(state.serverIds);
  const claimed = new Set<string>();
  for (const folderId of state.folderIds) {
    const folder = state.folders[folderId];
    if (!folder) return `folder ${folderId} not found`;
    if (folder.serverIds.length === 0) return `folder ${folderId} must not be empty`;
    if (hasDuplicates(folder.serverIds)) return `folder ${folderId} contains duplicate servers`;
    for (const serverId of folder.serverIds) {
      if (!membershipIds.has(serverId)) return `not a member of server ${serverId}`;
      if (claimed.has(serverId)) return `server ${serverId} belongs to multiple folders`;
      claimed.add(serverId);
    }
  }
  if (Object.keys(state.folders).some((folderId) => !state.folderIds.includes(folderId))) {
    return "folder state contains unordered folders";
  }
  return null;
}

function sameState(left: ServerRailState, right: ServerRailState): boolean {
  if (!sameArray(serverRailTopOrder(left).map((entry) => `${entry.kind}:${entry.id}`), serverRailTopOrder(right).map((entry) => `${entry.kind}:${entry.id}`))) return false;
  if (!sameSet(left.serverIds, right.serverIds)) return false;
  if (!sameSet(left.folderIds, right.folderIds)) return false;
  return left.folderIds.every((folderId) => {
    const a = left.folders[folderId];
    const b = right.folders[folderId];
    return a?.name === b?.name && sameArray(a?.serverIds ?? [], b?.serverIds ?? []);
  });
}

export function projectServerRailCommit(
  snapshot: ServerRailState,
  request: ServerRailCommitRequest,
  createFolderId: (clientId: string) => string,
): ServerRailProjectionResult {
  const recoveringFolderOverflow = snapshot.folderIds.length > MAX_SERVER_RAIL_FOLDERS;
  const beforeError = validateFinalState(snapshot, {
    allowFolderOverflow: recoveringFolderOverflow,
  });
  if (beforeError) return { ok: false, error: `invalid current rail: ${beforeError}`, status: 400 };
  if (
    recoveringFolderOverflow
    && request.commands.some((command) => command.kind !== "delete-folder")
  ) {
    return { ok: false, error: "folder limit recovery only permits deleting folders", status: 400 };
  }

  const after = cloneState(snapshot);
  const affectedFolderIds = new Set<string>();
  const deletedFolderIds = new Set<string>();
  const createdFolders: ServerRailFolderState[] = [];
  const createdFolderIds: Record<string, string> = {};
  const commandResources = new Set<string>();
  let requestedTopOrder: ServerRailEntry[] | undefined;
  let existingFolderMutations = 0;
  let createCount = 0;

  for (const command of request.commands) {
    if (command.kind === "reorder-top-level") {
      if (requestedTopOrder) return { ok: false, error: "duplicate reorder-top-level command", status: 400 };
      requestedTopOrder = command.entries;
      continue;
    }

    if (command.kind === "create-folder") {
      createCount += 1;
      if (createCount > 1 || createdFolderIds[command.clientId]) {
        return { ok: false, error: "duplicate create-folder command", status: 400 };
      }
      const id = createFolderId(command.clientId);
      if (!id || after.folders[id]) return { ok: false, error: "invalid created folder id", status: 400 };
      const folder = { id, name: command.name, serverIds: [...command.serverIds] };
      createdFolderIds[command.clientId] = id;
      createdFolders.push(folder);
      after.folders[id] = folder;
      after.folderIds.push(id);
      continue;
    }

    const resource = `folder:${command.folderId}`;
    if (commandResources.has(resource)) {
      return { ok: false, error: `duplicate command for folder ${command.folderId}`, status: 400 };
    }
    commandResources.add(resource);
    existingFolderMutations += 1;
    if (existingFolderMutations > 2) {
      return { ok: false, error: "too many folder mutations", status: 400 };
    }
    if (!snapshot.folders[command.folderId]) {
      return { ok: false, error: `folder ${command.folderId} not found`, status: 404 };
    }
    affectedFolderIds.add(command.folderId);
    if (command.kind === "delete-folder") {
      delete after.folders[command.folderId];
      after.folderIds = after.folderIds.filter((id) => id !== command.folderId);
      deletedFolderIds.add(command.folderId);
    } else {
      after.folders[command.folderId] = {
        ...after.folders[command.folderId]!,
        serverIds: [...command.serverIds],
      };
    }
  }

  if (requestedTopOrder) {
    const entries = requestedTopOrder.map((entry) => entry.kind === "folder" ? { ...entry, id: createdFolderIds[entry.id] ?? entry.id } : entry);
    const expected = serverRailTopOrder(after).map((entry) => `${entry.kind}:${entry.id}`);
    if (!sameSet(entries.map((entry) => `${entry.kind}:${entry.id}`), expected)) {
      return { ok: false, error: "top-level entries must match current servers and folders", status: 400 };
    }
    after.topOrder = entries;
  } else {
    after.topOrder = serverRailTopOrder(after);
  }
  const reorderTopLevel = !sameArray(serverRailTopOrder(snapshot).map((entry) => `${entry.kind}:${entry.id}`), serverRailTopOrder(after).map((entry) => `${entry.kind}:${entry.id}`));
  const folderCountImproved = after.folderIds.length < snapshot.folderIds.length;
  if (recoveringFolderOverflow && !folderCountImproved) {
    return { ok: false, error: "folder limit recovery must reduce the folder count", status: 400 };
  }
  const afterError = validateFinalState(after, {
    allowFolderOverflow: recoveringFolderOverflow && folderCountImproved,
  });
  if (afterError) return { ok: false, error: afterError, status: afterError.includes("not found") ? 404 : 400 };
  if (sameState(snapshot, after)) return { ok: false, error: "rail command is a no-op", status: 400 };

  const beforeParents = parentByServer(snapshot);
  const afterParents = parentByServer(after);
  const movedServerIds = after.serverIds.filter(
    (serverId) => beforeParents.get(serverId) !== afterParents.get(serverId),
  );

  return {
    ok: true,
    value: {
      before: cloneState(snapshot),
      after,
      affectedFolderIds: [...affectedFolderIds],
      movedServerIds,
      createdFolders,
      deletedFolderIds: [...deletedFolderIds],
      reorderTopLevel,
      createdFolderIds,
    },
  };
}
