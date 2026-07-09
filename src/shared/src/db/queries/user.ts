import { eq, inArray, sql, and, ne, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { user } from "../schema";
import type { Database } from "../index";
import { escapeLikePattern } from "../../utils/sql-like";
import { computeDiscriminator } from "../../lib/discriminator";
import { isUniqueConstraintError } from "../../utils/db-errors";

/** Bounded retry ceiling for `withUniqueDiscriminator`/`probeAvailableDiscriminator` salting. */
const MAX_DISCRIMINATOR_ATTEMPTS = 5;

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

// ─── Public vs. self lookups (as of 2026-07-09) ─────────────────────────────
//
// Every lookup below is one of exactly two kinds, and the function name is
// now the only contract — there is no boolean flag left for a caller to
// forget to pass:
//
//   - "Public" lookups (`getUserPublic`, `getUserByNameCaseInsensitive`,
//     `getUserByNameAndDiscriminator`, `searchUsersByName`) always exclude
//     soft-deleted rows. Used to resolve *someone else's* identity from a
//     public-facing surface (profile, block, search, friend-request-by-
//     username, DM-ref resolution) — a tombstoned account must never appear
//     live on any of these.
//   - "Self" lookups (`getUserSelf`, `getUsersByIds`, `getUserByEmail`) never
//     filter `deletedAt`. Used for the caller's own row, or for hydrating
//     already-known ids/emails from an internal/identity/history context
//     (own profile, own post/DM creation, Better-Auth adapter, email
//     dispatch, calendar, task payload building, tombstone rendering in
//     channel history) — none of these are "is this account still live"
//     checks, so there is nothing to filter.
//
// This previously lived behind a shared `excludeDeleted?: boolean` option
// with a `false` default. Two real call sites (`users/[userId]/profile`,
// `users/[userId]/block`) silently relied on that default and rendered a
// soft-deleted account as if it were live; `users/search` had the same bug
// via `searchUsersByName`. Splitting into named functions with no option
// closes that hole structurally instead of asking every future caller to
// remember a flag.

export async function getUserPublic(
  db: Database,
  id: string
): Promise<PublicUser | null> {
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(and(eq(user.id, id), isNull(user.deletedAt)));
  return (rows[0] as PublicUser | undefined) ?? null;
}

export async function getUserSelf(
  db: Database,
  id: string
): Promise<PublicUser | null> {
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(eq(user.id, id));
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

/** Self/internal — history + tombstone rendering (channel threads/posts creator hydration). */
export async function getUsersByIds(
  db: Database,
  ids: string[]
): Promise<PublicUser[]> {
  if (ids.length === 0) return [];
  return db
    .select(publicUserColumns)
    .from(user)
    .where(inArray(user.id, ids)) as Promise<PublicUser[]>;
}

/** Self/internal — Better-Auth adapter path. */
export async function getUserByEmail(
  db: Database,
  email: string
): Promise<PublicUser | null> {
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(eq(user.email, email));
  return (rows[0] as PublicUser | undefined) ?? null;
}

/** Public — bare-name fallback path (e.g. friend-request-by-username with no `#tag`). */
export async function getUserByNameCaseInsensitive(
  db: Database,
  name: string
): Promise<PublicUser | null> {
  const pattern = escapeLikePattern(name);
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(and(sql`${user.name} LIKE ${pattern} ESCAPE '\\'`, isNull(user.deletedAt)));
  return (rows[0] as PublicUser | undefined) ?? null;
}

/** Public — user picker / add-friend search surface. Always excludes deleted rows. */
export async function searchUsersByName(
  db: Database,
  name: string,
  opts?: {
    excludeUserId?: string;
    limit?: number;
    /** When set, filter to an exact name + discriminator match (`name#0042`). */
    discriminator?: string;
  }
): Promise<PublicUser[]> {
  const conditions: any[] = [isNull(user.deletedAt)];
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
  return db
    .select(publicUserColumns)
    .from(user)
    .where(and(...conditions))
    .limit(opts?.limit ?? 20) as Promise<PublicUser[]>;
}

/**
 * Exact `name#0042` lookup — case-insensitive on `name` (matching
 * `getUserByNameCaseInsensitive`'s existing behavior so a caller switching
 * from bare-name to `name#tag` lookup doesn't regress case handling), exact
 * match on `discriminator`. Used by DM-ref resolution and mention/friend
 * disambiguation, where the pair must resolve to exactly one user. Public —
 * always excludes deleted rows.
 */
export async function getUserByNameAndDiscriminator(
  db: Database,
  name: string,
  discriminator: string
): Promise<PublicUser | null> {
  const pattern = escapeLikePattern(name);
  const rows = await db
    .select(publicUserColumns)
    .from(user)
    .where(
      and(
        sql`${user.name} LIKE ${pattern} ESCAPE '\\'`,
        eq(user.discriminator, discriminator),
        isNull(user.deletedAt)
      )
    )
    .limit(1);
  return (rows[0] as PublicUser | undefined) ?? null;
}

/**
 * Wrap an insert that writes `computeDiscriminator(id)` so a collision
 * against the partial unique index (`idx_user_name_discriminator`, migration
 * 0055) self-heals instead of failing the caller's whole request. Calls
 * `insertFn(discriminator)`; on `isUniqueConstraintError` retries with
 * `computeDiscriminator(id + ":" + attempt)` and a FRESH `insertFn` call
 * (the caller's `insertFn` closure re-reads the salted discriminator each
 * time — see `createUser`/`createBot`), bounded to
 * `MAX_DISCRIMINATOR_ATTEMPTS`. Throws past the bound rather than looping
 * forever — a persistent failure past a handful of attempts is almost
 * certainly not actually a discriminator collision.
 */
export async function withUniqueDiscriminator<T>(
  _db: Database,
  input: { id: string; name: string },
  insertFn: (discriminator: string) => Promise<T>
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_DISCRIMINATOR_ATTEMPTS; attempt++) {
    const discriminator =
      attempt === 0
        ? computeDiscriminator(input.id)
        : computeDiscriminator(`${input.id}:${attempt}`);
    try {
      return await insertFn(discriminator);
    } catch (err) {
      if (!isUniqueConstraintError(err)) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

/**
 * Best-effort SELECT-based pre-check for callers that can't wrap their own
 * insert (Better Auth's `user.create.before` hook — the adapter inserts
 * AFTER the hook returns, so there's no insert call here to retry). Returns
 * an available discriminator, salting past a live `(name, discriminator)`
 * collision the same way `withUniqueDiscriminator` does. This is weaker than
 * `withUniqueDiscriminator`: a concurrent signup of the exact same name at
 * the exact same instant can still race past this check. The partial unique
 * index is the actual backstop for that residual window — a double-loss
 * fails Better Auth's insert, the signup surfaces a generic error, and the
 * user's retry mints a fresh id/discriminator pair. Self-healing, not
 * silently broken; not full parity with the insert-wrapped paths.
 */
export async function probeAvailableDiscriminator(
  db: Database,
  input: { id: string; name: string }
): Promise<string> {
  for (let attempt = 0; attempt < MAX_DISCRIMINATOR_ATTEMPTS; attempt++) {
    const discriminator =
      attempt === 0
        ? computeDiscriminator(input.id)
        : computeDiscriminator(`${input.id}:${attempt}`);
    const existing = await getUserByNameAndDiscriminator(db, input.name, discriminator);
    if (!existing) return discriminator;
  }
  // Ceiling exhausted — hand back a salt PAST the ones the loop just
  // probed, not the last-tried value. `id:${MAX-1}` would be guaranteed
  // to collide (the loop just saw it taken); `id:${MAX}` has NOT been
  // probed, so the caller's INSERT still has a chance. The partial unique
  // index is the real backstop for a true concurrent double-collision.
  return computeDiscriminator(`${input.id}:${MAX_DISCRIMINATOR_ATTEMPTS}`);
}

export async function createUser(
  db: Database,
  data: { name: string; email: string }
): Promise<PublicUser> {
  if (!data.name.trim()) throw new Error("user.name cannot be empty");
  // Generate the id up-front so the discriminator (an FNV-1a hash of the id)
  // can be written in the same INSERT — no separate UPDATE round-trip.
  const id = nanoid();
  return withUniqueDiscriminator(db, { id, name: data.name }, async (discriminator) => {
    const rows = await db
      .insert(user)
      .values({
        id,
        name: data.name,
        email: data.email,
        discriminator,
      })
      .returning(publicUserColumns);
    return rows[0] as PublicUser;
  });
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
