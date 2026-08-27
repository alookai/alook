import { z } from "zod";
import { MAX_FOLDER_NAME_LENGTH } from "./constants/community";

export const MAX_SERVER_RAIL_COMMANDS = 3;
export const MAX_SERVER_RAIL_FOLDERS = 10;
export const MAX_SERVER_RAIL_REQUEST_BYTES = 1_000_000;
export const SERVER_RAIL_SNAPSHOT_STATEMENTS = 3;
export const SERVER_RAIL_MAX_WRITE_STATEMENTS = 13;

const idSchema = z.string().trim().min(1);
const idsSchema = z.array(idSchema);

const reorderServersSchema = z.strictObject({
  kind: z.literal("reorder-servers"),
  serverIds: idsSchema,
});
const reorderFoldersSchema = z.strictObject({
  kind: z.literal("reorder-folders"),
  folderIds: idsSchema,
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
  reorderServersSchema,
  reorderFoldersSchema,
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
  serverOrder: string[];
  folderOrder: string[];
  folders: Record<string, ServerRailFolderState>;
};

export type ServerRailProjection = {
  before: ServerRailState;
  after: ServerRailState;
  affectedFolderIds: string[];
  movedServerIds: string[];
  createdFolders: ServerRailFolderState[];
  deletedFolderIds: string[];
  reorderServers: boolean;
  reorderFolders: boolean;
  createdFolderIds: Record<string, string>;
};

export type ServerRailProjectionResult =
  | { ok: true; value: ServerRailProjection }
  | { ok: false; error: string; status: 400 | 404 };

function cloneState(state: ServerRailState): ServerRailState {
  return {
    serverOrder: [...state.serverOrder],
    folderOrder: [...state.folderOrder],
    folders: Object.fromEntries(
      Object.entries(state.folders).map(([id, folder]) => [
        id,
        { ...folder, serverIds: [...folder.serverIds] },
      ]),
    ),
  };
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
    state.serverOrder.map((serverId) => [serverId, null]),
  );
  for (const folderId of state.folderOrder) {
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
  if (hasDuplicates(state.serverOrder)) return "serverIds must be unique";
  if (hasDuplicates(state.folderOrder)) return "folderIds must be unique";
  if (!options.allowFolderOverflow && state.folderOrder.length > MAX_SERVER_RAIL_FOLDERS) {
    return "folder limit reached";
  }
  const membershipIds = new Set(state.serverOrder);
  const claimed = new Set<string>();
  for (const folderId of state.folderOrder) {
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
  if (Object.keys(state.folders).some((folderId) => !state.folderOrder.includes(folderId))) {
    return "folder state contains unordered folders";
  }
  return null;
}

function sameState(left: ServerRailState, right: ServerRailState): boolean {
  if (!sameArray(left.serverOrder, right.serverOrder)) return false;
  if (!sameArray(left.folderOrder, right.folderOrder)) return false;
  return left.folderOrder.every((folderId) => {
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
  const recoveringFolderOverflow = snapshot.folderOrder.length > MAX_SERVER_RAIL_FOLDERS;
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
  let reorderServers = false;
  let reorderFolders = false;
  let existingFolderMutations = 0;
  let createCount = 0;

  for (const command of request.commands) {
    if (command.kind === "reorder-servers") {
      if (reorderServers) return { ok: false, error: "duplicate reorder-servers command", status: 400 };
      if (!sameSet(command.serverIds, snapshot.serverOrder)) {
        return { ok: false, error: "serverIds must match current memberships", status: 400 };
      }
      after.serverOrder = [...command.serverIds];
      reorderServers = true;
      continue;
    }

    if (command.kind === "reorder-folders") {
      if (reorderFolders) return { ok: false, error: "duplicate reorder-folders command", status: 400 };
      after.folderOrder = [...command.folderIds];
      reorderFolders = true;
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
      after.folderOrder.push(id);
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
      after.folderOrder = after.folderOrder.filter((id) => id !== command.folderId);
      deletedFolderIds.add(command.folderId);
    } else {
      after.folders[command.folderId] = {
        ...after.folders[command.folderId]!,
        serverIds: [...command.serverIds],
      };
    }
  }

  if (reorderFolders && !sameSet(after.folderOrder, Object.keys(after.folders))) {
    return { ok: false, error: "folderIds must match post-command folders", status: 400 };
  }

  const folderCountImproved = after.folderOrder.length < snapshot.folderOrder.length;
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
  const movedServerIds = after.serverOrder.filter(
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
      reorderServers,
      reorderFolders,
      createdFolderIds,
    },
  };
}
