import { and, eq, isNotNull, isNull, or } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { communityUserProfile } from "../../community-schema";
import { user } from "../../schema";
import type { Database } from "../../index";
import { formatHandle } from "../../../lib/discriminator";

export type PublicProfileIdentity =
  | { kind: "human" }
  | {
      kind: "bot";
      ownerProfile: { id: string; handle: string };
      ownedByViewer: boolean;
    };

export type PublicProfileForViewer = {
  id: string;
  name: string;
  discriminator: string;
  image: string | null;
  avatarVersion: number;
  aboutMe: string;
  bannerColor: string | null;
  statusEmoji: string | null;
  statusText: string;
  identity: PublicProfileIdentity;
};

/**
 * One-read public profile projection for another user's ProfileCard.
 *
 * The target, optional profile row, and (for bots) live owner identity are
 * joined in one query so the profile route does not add a serial owner lookup.
 * A bot whose target or owner is soft-deleted does not resolve. Ownership is
 * derived in SQL from the authenticated viewer id; the returned DTO exposes
 * only the owner's public navigation identity, never the internal ownership
 * field or email.
 */
export async function getPublicProfileForViewer(
  db: Database,
  targetUserId: string,
  viewerUserId: string
): Promise<PublicProfileForViewer | null> {
  const target = alias(user, "profile_target");
  const owner = alias(user, "profile_owner");
  const rows = await db
    .select({
      id: target.id,
      name: target.name,
      discriminator: target.discriminator,
      image: target.image,
      avatarVersion: target.avatarVersion,
      isBot: target.isBot,
      aboutMe: communityUserProfile.aboutMe,
      bannerColor: communityUserProfile.bannerColor,
      statusEmoji: communityUserProfile.statusEmoji,
      statusText: communityUserProfile.statusText,
      ownerId: owner.id,
      ownerName: owner.name,
      ownerDiscriminator: owner.discriminator,
      ownedByViewer: eq(owner.id, viewerUserId).mapWith(Boolean),
    })
    .from(target)
    .leftJoin(communityUserProfile, eq(communityUserProfile.userId, target.id))
    .leftJoin(
      owner,
      and(eq(owner.id, target.ownerUserId), isNull(owner.deletedAt))
    )
    .where(
      and(
        eq(target.id, targetUserId),
        isNull(target.deletedAt),
        or(eq(target.isBot, false), isNotNull(owner.id))
      )
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  const identity: PublicProfileIdentity = row.isBot
    ? {
        kind: "bot",
        ownerProfile: {
          id: row.ownerId!,
          handle: formatHandle(row.ownerName!, row.ownerDiscriminator!),
        },
        ownedByViewer: row.ownedByViewer,
      }
    : { kind: "human" };

  return {
    id: row.id,
    name: row.name,
    discriminator: row.discriminator,
    image: row.image,
    avatarVersion: row.avatarVersion,
    aboutMe: row.aboutMe ?? "",
    bannerColor: row.bannerColor ?? null,
    statusEmoji: row.statusEmoji ?? null,
    statusText: row.statusText ?? "",
    identity,
  };
}

export async function getProfile(db: Database, userId: string) {
  const rows = await db
    .select()
    .from(communityUserProfile)
    .where(eq(communityUserProfile.userId, userId));
  return rows[0] ?? null;
}

export async function updateProfile(
  db: Database,
  userId: string,
  data: {
    aboutMe?: string;
    bannerColor?: string | null;
    statusEmoji?: string | null;
    statusText?: string | null;
  }
) {
  const [row] = await db
    .insert(communityUserProfile)
    .values({
      userId,
      aboutMe: data.aboutMe ?? "",
      bannerColor: data.bannerColor ?? null,
      statusEmoji: data.statusEmoji ?? null,
      statusText: data.statusText ?? "",
    })
    .onConflictDoUpdate({
      target: communityUserProfile.userId,
      set: {
        ...(data.aboutMe !== undefined ? { aboutMe: data.aboutMe } : {}),
        ...(data.bannerColor !== undefined
          ? { bannerColor: data.bannerColor }
          : {}),
        ...(data.statusEmoji !== undefined
          ? { statusEmoji: data.statusEmoji }
          : {}),
        ...(data.statusText !== undefined
          ? { statusText: data.statusText }
          : {}),
      },
    })
    .returning();
  return row!;
}
