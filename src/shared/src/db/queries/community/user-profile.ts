import { eq } from "drizzle-orm";
import { communityUserProfile } from "../../community-schema";
import type { Database } from "../../index";

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
  data: { aboutMe?: string; bannerColor?: string | null }
) {
  const [row] = await db
    .insert(communityUserProfile)
    .values({
      userId,
      aboutMe: data.aboutMe ?? "",
      bannerColor: data.bannerColor ?? null,
    })
    .onConflictDoUpdate({
      target: communityUserProfile.userId,
      set: {
        ...(data.aboutMe !== undefined ? { aboutMe: data.aboutMe } : {}),
        ...(data.bannerColor !== undefined
          ? { bannerColor: data.bannerColor }
          : {}),
      },
    })
    .returning();
  return row!;
}
