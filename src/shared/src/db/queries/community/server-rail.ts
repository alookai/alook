import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { ServerRailProjection, ServerRailState } from "../../../community-server-rail";
import {
  MAX_SERVER_RAIL_FOLDERS,
  SERVER_RAIL_MAX_WRITE_STATEMENTS,
} from "../../../community-server-rail";
import {
  communityServerFolder,
  communityServerFolderItem,
  communityServerMember,
} from "../../community-schema";
import type { Database } from "../../index";

export async function readServerRailSnapshot(
  db: Database,
  userId: string,
): Promise<ServerRailState> {
  const currentMember = alias(communityServerMember, "current_member");
  const memberships = db
    .select({ serverId: communityServerMember.serverId })
    .from(communityServerMember)
    .where(eq(communityServerMember.userId, userId))
    .orderBy(
      asc(communityServerMember.railOrder),
      asc(communityServerMember.joinedAt),
      asc(communityServerMember.serverId),
    );
  const folders = db
    .select({
      id: communityServerFolder.id,
      name: communityServerFolder.name,
    })
    .from(communityServerFolder)
    .where(eq(communityServerFolder.userId, userId))
    .orderBy(
      asc(sql`COALESCE(${communityServerFolder.position}, 0)`),
      asc(communityServerFolder.id),
    );
  const items = db
    .select({
      folderId: communityServerFolderItem.folderId,
      serverId: communityServerFolderItem.serverId,
    })
    .from(communityServerFolderItem)
    .innerJoin(
      communityServerFolder,
      eq(communityServerFolder.id, communityServerFolderItem.folderId),
    )
    .innerJoin(
      currentMember,
      and(
        eq(currentMember.serverId, communityServerFolderItem.serverId),
        eq(currentMember.userId, userId),
      ),
    )
    .where(eq(communityServerFolder.userId, userId))
    .orderBy(
      asc(sql`COALESCE(${communityServerFolder.position}, 0)`),
      asc(communityServerFolder.id),
      asc(communityServerFolderItem.position),
      asc(communityServerFolderItem.serverId),
    );

  const [membershipRows, folderRows, itemRows] = await db.batch([
    memberships,
    folders,
    items,
  ] as any) as unknown as [
    Array<{ serverId: string }>,
    Array<{ id: string; name: string }>,
    Array<{ folderId: string; serverId: string }>,
  ];

  const claimedServerIds = new Set<string>();
  const projectedItemRows = itemRows.filter((row) => {
    if (claimedServerIds.has(row.serverId)) return false;
    claimedServerIds.add(row.serverId);
    return true;
  });
  const projectedFolderIds = new Set(projectedItemRows.map((row) => row.folderId));
  const projectedFolderRows = folderRows.filter((row) => projectedFolderIds.has(row.id));
  const state: ServerRailState = {
    serverOrder: membershipRows.map((row) => row.serverId),
    folderOrder: projectedFolderRows.map((row) => row.id),
    folders: Object.fromEntries(projectedFolderRows.map((row) => [
      row.id,
      { id: row.id, name: row.name, serverIds: [] },
    ])),
  };
  for (const item of projectedItemRows) {
    state.folders[item.folderId]?.serverIds.push(item.serverId);
  }
  return state;
}

function idListCte(db: Database, alias: string, ids: readonly string[]) {
  return db.$with(alias).as(
    db.select({
      id: sql<string>`CAST(value AS TEXT)`.as("id"),
      position: sql<number>`CAST(key AS INTEGER)`.as("position"),
    }).from(sql`json_each(${JSON.stringify(ids)})`),
  );
}

function membershipReorderStatement(
  db: Database,
  userId: string,
  serverIds: readonly string[],
) {
  const desired = idListCte(db, "desired_member_order", serverIds);
  return db.with(desired)
    .update(communityServerMember)
    .set({
      railOrder: sql<number>`(
        SELECT ${desired.position}
        FROM ${desired}
        WHERE ${desired.id} = ${communityServerMember.serverId}
      )`,
    })
    .where(and(
      eq(communityServerMember.userId, userId),
      sql`EXISTS (
        SELECT 1 FROM ${desired}
        WHERE ${desired.id} = ${communityServerMember.serverId}
      )`,
    ));
}

function folderReorderStatement(
  db: Database,
  userId: string,
  folderIds: readonly string[],
) {
  const desired = idListCte(db, "desired_folder_order", folderIds);
  return db.with(desired)
    .update(communityServerFolder)
    .set({
      position: sql<number>`(
        SELECT ${desired.position}
        FROM ${desired}
        WHERE ${desired.id} = ${communityServerFolder.id}
      )`,
    })
    .where(and(
      eq(communityServerFolder.userId, userId),
      sql`EXISTS (
        SELECT 1 FROM ${desired}
        WHERE ${desired.id} = ${communityServerFolder.id}
      )`,
    ));
}

function createFolderStatement(
  db: Database,
  userId: string,
  folder: { id: string; name: string },
) {
  const candidate = db.select({
    id: sql<string>`${folder.id}`.as("id"),
    userId: sql<string>`${userId}`.as("user_id"),
    name: sql<string>`${folder.name}`.as("name"),
    position: sql<number>`(
      SELECT COALESCE(MAX(${communityServerFolder.position}), -1) + 1
      FROM ${communityServerFolder}
      WHERE ${communityServerFolder.userId} = ${userId}
    )`.as("position"),
  }).from(sql`(SELECT 1)`)
    .where(sql`(
      SELECT COUNT(*)
      FROM ${communityServerFolder}
      WHERE ${communityServerFolder.userId} = ${userId}
    ) < ${MAX_SERVER_RAIL_FOLDERS}`);
  return db.insert(communityServerFolder).select(candidate);
}

function globalReassignedItemCleanupStatement(
  db: Database,
  userId: string,
  serverIds: readonly string[],
) {
  const moved = idListCte(db, "moved_server_ids", serverIds);
  return db.with(moved)
    .delete(communityServerFolderItem)
    .where(and(
      sql`EXISTS (
        SELECT 1 FROM ${moved}
        WHERE ${moved.id} = ${communityServerFolderItem.serverId}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${communityServerFolder}
        WHERE ${communityServerFolder.id} = ${communityServerFolderItem.folderId}
          AND ${communityServerFolder.userId} = ${userId}
      )`,
    ));
}

function clearAffectedFolderItemsStatement(
  db: Database,
  userId: string,
  folderIds: readonly string[],
) {
  const affected = idListCte(db, "affected_folder_ids", folderIds);
  return db.with(affected)
    .delete(communityServerFolderItem)
    .where(and(
      sql`EXISTS (
        SELECT 1 FROM ${affected}
        WHERE ${affected.id} = ${communityServerFolderItem.folderId}
      )`,
      sql`EXISTS (
        SELECT 1 FROM ${communityServerFolder}
        WHERE ${communityServerFolder.id} = ${communityServerFolderItem.folderId}
          AND ${communityServerFolder.userId} = ${userId}
      )`,
    ));
}

function deleteFoldersStatement(
  db: Database,
  userId: string,
  folderIds: readonly string[],
) {
  const deleted = idListCte(db, "deleted_folder_ids", folderIds);
  return db.with(deleted)
    .delete(communityServerFolder)
    .where(and(
      eq(communityServerFolder.userId, userId),
      sql`EXISTS (
        SELECT 1 FROM ${deleted}
        WHERE ${deleted.id} = ${communityServerFolder.id}
      )`,
    ));
}

function deleteEmptyFoldersStatement(db: Database, userId: string) {
  return db.delete(communityServerFolder)
    .where(and(
      eq(communityServerFolder.userId, userId),
      sql`NOT EXISTS (
        SELECT 1 FROM ${communityServerFolderItem}
        WHERE ${communityServerFolderItem.folderId} = ${communityServerFolder.id}
      )`,
    ));
}

function deleteDanglingFolderItemsStatement(db: Database, userId: string) {
  return db.delete(communityServerFolderItem)
    .where(and(
      sql`EXISTS (
        SELECT 1 FROM ${communityServerFolder}
        WHERE ${communityServerFolder.id} = ${communityServerFolderItem.folderId}
          AND ${communityServerFolder.userId} = ${userId}
      )`,
      sql`NOT EXISTS (
        SELECT 1 FROM ${communityServerMember}
        WHERE ${communityServerMember.serverId} = ${communityServerFolderItem.serverId}
          AND ${communityServerMember.userId} = ${userId}
      )`,
    ));
}

function deleteDuplicateFolderItemsStatement(db: Database, userId: string) {
  return db.delete(communityServerFolderItem)
    .where(sql`EXISTS (
      SELECT 1
      FROM community_server_folder_item AS preferred_item
      INNER JOIN community_server_folder AS preferred_folder
        ON preferred_folder.id = preferred_item.folder_id
      INNER JOIN community_server_folder AS current_folder
        ON current_folder.id = ${communityServerFolderItem.folderId}
      WHERE preferred_item.server_id = ${communityServerFolderItem.serverId}
        AND preferred_folder.user_id = ${userId}
        AND current_folder.user_id = ${userId}
        AND (
          COALESCE(preferred_folder.position, 0) < COALESCE(current_folder.position, 0)
          OR (
            COALESCE(preferred_folder.position, 0) = COALESCE(current_folder.position, 0)
            AND preferred_folder.id < current_folder.id
          )
        )
    )`);
}

function insertFolderItemsStatement(
  db: Database,
  userId: string,
  rows: Array<{ folderId: string; serverId: string; position: number }>,
) {
  const desired = db.$with("desired_folder_items").as(
    db.select({
      folderId: sql<string>`CAST(json_extract(value, '$.folderId') AS TEXT)`.as("folder_id"),
      serverId: sql<string>`CAST(json_extract(value, '$.serverId') AS TEXT)`.as("server_id"),
      position: sql<number>`CAST(json_extract(value, '$.position') AS INTEGER)`.as("position"),
    }).from(sql`json_each(${JSON.stringify(rows)})`),
  );
  const ownedFolder = alias(communityServerFolder, "owned_folder");
  const ownedMember = alias(communityServerMember, "owned_member");
  const desiredFolderId = sql<string>`"desired_folder_items"."folder_id"`;
  const desiredServerId = sql<string>`"desired_folder_items"."server_id"`;
  const desiredPosition = sql<number>`"desired_folder_items"."position"`.as("position");
  const selected = db.select({
    folderId: ownedFolder.id,
    serverId: ownedMember.serverId,
    position: desiredPosition,
  })
    .from(desired)
    .leftJoin(
      ownedFolder,
      and(eq(ownedFolder.id, desiredFolderId), eq(ownedFolder.userId, userId)),
    )
    .leftJoin(
      ownedMember,
      and(eq(ownedMember.serverId, desiredServerId), eq(ownedMember.userId, userId)),
    );
  return db.with(desired).insert(communityServerFolderItem).select(selected);
}

function normalizeFolderPositionsStatement(db: Database, userId: string) {
  const ranked = db.$with("ranked_folders").as(
    db.select({
      id: communityServerFolder.id,
      position: sql<number>`ROW_NUMBER() OVER (
        ORDER BY COALESCE(${communityServerFolder.position}, 0), ${communityServerFolder.id}
      ) - 1`.as("position"),
    })
      .from(communityServerFolder)
      .where(eq(communityServerFolder.userId, userId)),
  );
  return db.with(ranked)
    .update(communityServerFolder)
    .set({
      position: sql<number>`(
        SELECT ${ranked.position} FROM ${ranked}
        WHERE ${ranked.id} = ${communityServerFolder.id}
      )`,
    })
    .where(and(
      eq(communityServerFolder.userId, userId),
      sql`EXISTS (SELECT 1 FROM ${ranked} WHERE ${ranked.id} = ${communityServerFolder.id})`,
    ));
}

function normalizeFolderItemPositionsStatement(db: Database, userId: string) {
  const ranked = db.$with("ranked_folder_items").as(
    db.select({
      folderId: communityServerFolderItem.folderId,
      serverId: communityServerFolderItem.serverId,
      position: sql<number>`ROW_NUMBER() OVER (
        PARTITION BY ${communityServerFolderItem.folderId}
        ORDER BY COALESCE(${communityServerFolderItem.position}, 0), ${communityServerFolderItem.serverId}
      ) - 1`.as("position"),
    })
      .from(communityServerFolderItem)
      .innerJoin(
        communityServerFolder,
        eq(communityServerFolder.id, communityServerFolderItem.folderId),
      )
      .where(eq(communityServerFolder.userId, userId)),
  );
  return db.with(ranked)
    .update(communityServerFolderItem)
    .set({
      position: sql<number>`(
        SELECT ${ranked.position} FROM ${ranked}
        WHERE ${ranked.folderId} = ${communityServerFolderItem.folderId}
          AND ${ranked.serverId} = ${communityServerFolderItem.serverId}
      )`,
    })
    .where(sql`EXISTS (
      SELECT 1 FROM ${ranked}
      WHERE ${ranked.folderId} = ${communityServerFolderItem.folderId}
        AND ${ranked.serverId} = ${communityServerFolderItem.serverId}
    )`);
}

export function buildServerRailWriteStatements(
  db: Database,
  userId: string,
  projection: ServerRailProjection,
) {
  const statements: any[] = [
    deleteDanglingFolderItemsStatement(db, userId),
    deleteDuplicateFolderItemsStatement(db, userId),
    deleteEmptyFoldersStatement(db, userId),
  ];
  const itemFolderIds = new Set([
    ...projection.affectedFolderIds.filter((id) => !projection.deletedFolderIds.includes(id)),
    ...projection.createdFolders.map((folder) => folder.id),
  ]);
  const desiredItems = [...itemFolderIds].flatMap((folderId) =>
    (projection.after.folders[folderId]?.serverIds ?? []).map((serverId, position) => ({
      folderId,
      serverId,
      position,
    })),
  );
  const reassignedServerIds = [...new Set([
    ...projection.movedServerIds,
    ...desiredItems.map((item) => item.serverId),
  ])];
  if (projection.createdFolders.length > 0) {
    statements.push(createFolderStatement(db, userId, projection.createdFolders[0]!));
  }
  if (reassignedServerIds.length > 0) {
    statements.push(globalReassignedItemCleanupStatement(db, userId, reassignedServerIds));
  }
  if (projection.affectedFolderIds.length > 0) {
    statements.push(clearAffectedFolderItemsStatement(db, userId, projection.affectedFolderIds));
  }
  if (projection.deletedFolderIds.length > 0) {
    statements.push(deleteFoldersStatement(db, userId, projection.deletedFolderIds));
  }

  if (desiredItems.length > 0) {
    statements.push(insertFolderItemsStatement(db, userId, desiredItems));
  }
  if (projection.reorderServers) {
    statements.push(membershipReorderStatement(db, userId, projection.after.serverOrder));
  }
  if (projection.reorderFolders) {
    statements.push(folderReorderStatement(db, userId, projection.after.folderOrder));
  }
  statements.push(deleteEmptyFoldersStatement(db, userId));
  statements.push(normalizeFolderPositionsStatement(db, userId));
  statements.push(normalizeFolderItemPositionsStatement(db, userId));
  if (statements.length === 0 || statements.length > SERVER_RAIL_MAX_WRITE_STATEMENTS) {
    throw new Error(`invalid server rail write statement count: ${statements.length}`);
  }
  return statements as [any, ...any[]];
}

export async function applyServerRailProjection(
  db: Database,
  userId: string,
  projection: ServerRailProjection,
): Promise<void> {
  const statements = buildServerRailWriteStatements(db, userId, projection);
  await db.batch(statements as any);
}
