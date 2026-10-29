import { and, asc, desc, eq, gt, inArray, isNull, ne, or } from "drizzle-orm"
import { nanoid } from "nanoid"
import { automationAccessCode as code, automationAccessPermission as policy } from "../automation-schema"
import { user } from "../schema"
import { communityMachine } from "../community-machine-schema"
import { communityFriendship } from "../community-schema"
import { parseNameAndTag } from "../../lib/discriminator"
import type { Database } from "../index"
import { automationExpiresAt, type AutomationAccessCode, type AutomationAccessCodeCreate, type AutomationAccessCodeUpdate, type AutomationPermission } from "../../automation"

const publicFields = { id: code.id, name: code.name, createdAt: code.createdAt, expiresAt: code.expiresAt }

export async function listAccessCodes(db: Database, ownerId: string): Promise<AutomationAccessCode[]> {
  const rows = await db.select({ ...publicFields, permission: policy.permission, limit: policy.limit, period: policy.period })
    .from(code).leftJoin(policy, eq(policy.codeId, code.id)).where(eq(code.ownerId, ownerId))
    .orderBy(desc(code.createdAt), asc(policy.permission))
  const codes = new Map<string, AutomationAccessCode>()
  for (const row of rows) {
    let item = codes.get(row.id)
    if (!item) {
      item = { id: row.id, name: row.name, createdAt: row.createdAt, expiresAt: row.expiresAt, permissions: [] }
      codes.set(row.id, item)
    }
    if (row.permission && row.limit !== null && row.period) item.permissions.push({ permission: row.permission, limit: row.limit, period: row.period })
  }
  return [...codes.values()]
}

export async function getAccessCode(db: Database, ownerId: string, id: string): Promise<AutomationAccessCode | null> {
  const [row] = await db.select(publicFields).from(code).where(and(eq(code.ownerId, ownerId), eq(code.id, id)))
  if (!row) return null
  const permissions = await db.select({ permission: policy.permission, limit: policy.limit, period: policy.period }).from(policy)
    .where(and(eq(policy.codeId, id), inArray(policy.codeId, db.select({ id: code.id }).from(code).where(eq(code.ownerId, ownerId)))))
    .orderBy(asc(policy.permission))
  return { ...row, permissions }
}

export async function createAccessCode(db: Database, ownerId: string, input: AutomationAccessCodeCreate, secretHash: string): Promise<AutomationAccessCode> {
  const row = { id: nanoid(), ownerId, name: input.name, secretHash, createdAt: new Date().toISOString(), expiresAt: automationExpiresAt(input.expiresIn) }
  await db.batch([
    db.insert(code).values(row),
    db.insert(policy).values(input.permissions.map((permission) => ({ ...permission, codeId: row.id }))),
  ])
  return { id: row.id, name: row.name, createdAt: row.createdAt, expiresAt: row.expiresAt, permissions: input.permissions }
}

export async function updateAccessCode(db: Database, ownerId: string, id: string, input: AutomationAccessCodeUpdate): Promise<AutomationAccessCode | null> {
  const current = await getAccessCode(db, ownerId, id)
  if (!current) return null
  const owned = and(eq(code.ownerId, ownerId), eq(code.id, id))
  const fields = {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.expiresIn === undefined ? {} : { expiresAt: automationExpiresAt(input.expiresIn) }),
  }
  if (input.permissions) {
    const remove = db.delete(policy).where(inArray(policy.codeId, db.select({ id: code.id }).from(code).where(owned)))
    const insert = db.insert(policy).values(input.permissions.map((permission) => ({ ...permission, codeId: id })))
    if (Object.keys(fields).length) await db.batch([db.update(code).set(fields).where(owned), remove, insert])
    else await db.batch([remove, insert])
  } else if (Object.keys(fields).length) await db.update(code).set(fields).where(owned)
  return getAccessCode(db, ownerId, id)
}

export async function deleteAccessCode(db: Database, ownerId: string, id: string): Promise<boolean> {
  const rows = await db.delete(code).where(and(eq(code.ownerId, ownerId), eq(code.id, id))).returning({ id: code.id })
  return rows.length > 0
}

export async function authenticateAccessCode(db: Database, secretHash: string, permission: AutomationPermission, now = new Date().toISOString()) {
  const [row] = await db.select({ codeId: code.id, ownerId: code.ownerId, permission: policy.permission, limit: policy.limit, period: policy.period })
    .from(code).innerJoin(policy, and(eq(policy.codeId, code.id), eq(policy.permission, permission)))
    .innerJoin(user, and(eq(user.id, code.ownerId), eq(user.isBot, false), isNull(user.deletedAt)))
    .where(and(eq(code.secretHash, secretHash), or(isNull(code.expiresAt), gt(code.expiresAt, now))))
  return row ?? null
}

export function listMachines(db: Database, ownerId: string) {
  return db.select({ id: communityMachine.id, name: communityMachine.displayName, status: communityMachine.status, availableRuntimes: communityMachine.availableRuntimes }).from(communityMachine)
    .where(eq(communityMachine.userId, ownerId)).orderBy(asc(communityMachine.id))
}

function friendScope(db: Database, ownerId: string) {
  return and(isNull(user.deletedAt), ne(user.id, ownerId), or(
    and(eq(user.isBot, true), eq(user.ownerUserId, ownerId)),
    inArray(user.id, db.select({ id: communityFriendship.addresseeId }).from(communityFriendship)
      .where(and(eq(communityFriendship.status, "accepted"), eq(communityFriendship.requesterId, ownerId)))),
    inArray(user.id, db.select({ id: communityFriendship.requesterId }).from(communityFriendship)
      .where(and(eq(communityFriendship.status, "accepted"), eq(communityFriendship.addresseeId, ownerId)))),
  ))
}

export function listFriends(db: Database, ownerId: string) {
  return db.select({ name: user.name, discriminator: user.discriminator, isBot: user.isBot, ownerUserId: user.ownerUserId }).from(user)
    .where(friendScope(db, ownerId)).orderBy(asc(user.name), asc(user.discriminator))
}

export async function getFriendByHandle(db: Database, ownerId: string, handle: string) {
  const parsed = parseNameAndTag(handle)
  if (!parsed) return null
  const [row] = await db.select({ id: user.id, name: user.name, discriminator: user.discriminator }).from(user)
    .where(and(friendScope(db, ownerId), eq(user.name, parsed.name), eq(user.discriminator, parsed.discriminator)))
  return row ?? null
}

export async function getOwnedBotByHandle(db: Database, ownerId: string, handle: string) {
  const parsed = parseNameAndTag(handle)
  if (!parsed) return null
  const [row] = await db.select({ id: user.id }).from(user).where(and(
    eq(user.ownerUserId, ownerId), eq(user.isBot, true), isNull(user.deletedAt),
    eq(user.name, parsed.name), eq(user.discriminator, parsed.discriminator),
  )).limit(1)
  return row ?? null
}
