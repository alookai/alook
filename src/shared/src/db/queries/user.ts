import { eq, inArray, like, sql, and, ne, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { user } from "../schema";
import type { Database } from "../index";
import { escapeLikePattern } from "../../utils/sql-like";
import { computeDiscriminator } from "../../lib/discriminator";

// ─── Column projections ──────────────────────────────────────────────────────
//
// `queries.user.*` used to `.select()` every column, which silently leaked new
// columns (isBot / ownerUserId / deletedAt) into every downstream consumer,
// including Better-Auth's session payload. To fix that safely-by-default:
//
//   - getUser*     — return `PublicUser`  (no internal columns).
//   - getUserInternal — return `PublicUser & InternalUserFields`, for ownership
//                       scoping, session guards, and other trusted paths only.
//
// New columns default to `InternalUserFields`. Adding a public one requires an
// explicit change to the `publicUserColumns` projection below.

const publicUserColumns = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  image: user.image,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
  discriminator: user.discriminator,
} as const;

const internalUserColumns = {
  ...publicUserColumns,
  isBot: user.isBot,
  ownerUserId: user.ownerUserId,
  deletedAt: user.deletedAt,
} as const;

export type PublicUser = {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean | null;
  image: string | null;
  createdAt: string;
  updatedAt: string;
  discriminator: string;
};

export type InternalUserFields = {
  isBot: boolean;
  ownerUserId: string | null;
  deletedAt: string | null;
};

export type InternalUser = PublicUser & InternalUserFields;

// ─── Caller audit (as of 2026-07-06) ────────────────────────────────────────
//
// `excludeDeleted` defaults to `false` for backward compatibility — flipping
// the default would silently break admin, session, and history-hydration
// paths. Every current caller is enumerated below with its decision:
//
//   getUser:
//     - api/me                                      → false (own row, keep)
//     - api/community/dm  (target lookup)           → true  (listing surface)
//     - api/community/users/[id]/block/profile      → true  (public surface)
//     - api/community/friends/request               → true  (must not friend deleted users)
//     - api/community/channels/.../posts (create)   → false (self hydration)
//     - services/email-dispatch, calendar, payload  → false (identity lookup)
//
//   getUsersByIds:
//     - channel threads/posts creator hydration     → false (history, tombstone renders)
//
//   getUserByEmail:
//     - (Better-Auth adapter path, indirect)        → false
//
//   getUserByNameCaseInsensitive / searchUsersByName:
//     - api/community/friends/request (username)    → true  (send to live users only)
//     - api/community/users/search                  → true  (user picker surface)
//
// The call-sites above are updated to pass `{ excludeDeleted: true }` where
// the plan requires filtering deleted users. All others rely on the default.

function withDeletedFilter(condition: unknown, excludeDeleted: boolean) {
  if (!excludeDeleted) return condition as any;
  return and(condition as any, isNull(user.deletedAt));
}

export async function getUser(
  db: Database,
  id: string,
  opts?: { excludeDeleted?: boolean }
): Promise<PublicUser | null> {
  const excludeDeleted = opts?.excludeDeleted === true;
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(withDeletedFilter(eq(user.id, id), excludeDeleted));
  return (rows[0] as PublicUser | undefined) ?? null;
}

export async function getUserInternal(
  db: Database,
  id: string
): Promise<InternalUser | null> {
  const rows = await db
    .select(internalUserColumns)
    .from(user)
    .where(eq(user.id, id));
  return (rows[0] as InternalUser | undefined) ?? null;
}

export async function getUsersByIds(
  db: Database,
  ids: string[],
  opts?: { excludeDeleted?: boolean }
): Promise<PublicUser[]> {
  if (ids.length === 0) return [];
  const excludeDeleted = opts?.excludeDeleted === true;
  return db
    .select(publicUserColumns)
    .from(user)
    .where(withDeletedFilter(inArray(user.id, ids), excludeDeleted)) as Promise<PublicUser[]>;
}

export async function getUserByEmail(
  db: Database,
  email: string,
  opts?: { excludeDeleted?: boolean }
): Promise<PublicUser | null> {
  const excludeDeleted = opts?.excludeDeleted === true;
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(withDeletedFilter(eq(user.email, email), excludeDeleted));
  return (rows[0] as PublicUser | undefined) ?? null;
}

export async function getUserByNameCaseInsensitive(
  db: Database,
  name: string,
  opts?: { excludeDeleted?: boolean }
): Promise<PublicUser | null> {
  const excludeDeleted = opts?.excludeDeleted === true;
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(withDeletedFilter(like(user.name, name), excludeDeleted));
  return (rows[0] as PublicUser | undefined) ?? null;
}

export async function searchUsersByName(
  db: Database,
  name: string,
  opts?: {
    excludeUserId?: string;
    limit?: number;
    excludeDeleted?: boolean;
    /** When set, filter to an exact name + discriminator match (`name#0042`). */
    discriminator?: string;
  }
): Promise<PublicUser[]> {
  const conditions: any[] = [];
  if (opts?.discriminator !== undefined) {
    // Exact match — used by the `name#0042` add-friend search path.
    conditions.push(eq(user.name, name));
    conditions.push(eq(user.discriminator, opts.discriminator));
  } else {
    const pattern = `%${escapeLikePattern(name)}%`;
    conditions.push(sql`${user.name} LIKE ${pattern} ESCAPE '\\'`);
  }
  if (opts?.excludeUserId) {
    conditions.push(ne(user.id, opts.excludeUserId));
  }
  if (opts?.excludeDeleted) {
    conditions.push(isNull(user.deletedAt));
  }
  return db
    .select(publicUserColumns)
    .from(user)
    .where(and(...conditions))
    .limit(opts?.limit ?? 20) as Promise<PublicUser[]>;
}

export async function createUser(
  db: Database,
  data: { name: string; email: string }
): Promise<PublicUser> {
  if (!data.name.trim()) throw new Error("user.name cannot be empty");
  // Generate the id up-front so the discriminator (an FNV-1a hash of the id)
  // can be written in the same INSERT — no separate UPDATE round-trip.
  const id = nanoid();
  const rows = await db
    .insert(user)
    .values({
      id,
      name: data.name,
      email: data.email,
      discriminator: computeDiscriminator(id),
    })
    .returning(publicUserColumns);
  return rows[0] as PublicUser;
}

/** omit a field to leave it unchanged; pass image: null to explicitly clear it. */
export async function updateUser(
  db: Database,
  id: string,
  data: { name?: string; image?: string | null }
): Promise<PublicUser | null> {
  if (data.name !== undefined && !data.name.trim()) {
    throw new Error("user.name cannot be empty");
  }
  const set: { name?: string; image?: string | null; updatedAt: string } = {
    updatedAt: new Date().toISOString(),
  };
  if (data.name !== undefined) set.name = data.name;
  if (data.image !== undefined) set.image = data.image;
  const rows = await db
    .update(user)
    .set(set)
    .where(eq(user.id, id))
    .returning(publicUserColumns);
  return (rows[0] as PublicUser | undefined) ?? null;
}
