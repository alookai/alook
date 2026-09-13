import { and, asc, eq, isNull, or } from "drizzle-orm";
import { communityPushDevice } from "../../community-schema";
import type { Database } from "../../index";

export type PushDevicePlatform = "ios" | "android";
export type PushProviderEnvironment = "sandbox" | "production";

export interface PushDeviceMetadata {
  installationId: string;
  platform: PushDevicePlatform;
  providerEnvironment: PushProviderEnvironment;
  appVersion: string | null;
  lastSeenAt: string;
  disabledAt: string | null;
}

export interface ActivePushDevice {
  id: string;
  installationId: string;
  platform: PushDevicePlatform;
  providerEnvironment: PushProviderEnvironment;
  providerTokenEncrypted: string;
}

export interface RegisterPushDeviceInput {
  userId: string;
  installationId: string;
  platform: PushDevicePlatform;
  providerEnvironment: PushProviderEnvironment;
  providerTokenEncrypted: string;
  providerTokenHash: string;
  previousProviderTokenHash?: string;
  appVersion?: string;
  now: string;
}

export type RegisterPushDeviceResult =
  | { ok: true; device: PushDeviceMetadata }
  | { ok: false; reason: "ownership-conflict" };

const metadataProjection = {
  installationId: communityPushDevice.installationId,
  platform: communityPushDevice.platform,
  providerEnvironment: communityPushDevice.providerEnvironment,
  appVersion: communityPushDevice.appVersion,
  lastSeenAt: communityPushDevice.lastSeenAt,
  disabledAt: communityPushDevice.disabledAt,
};

export async function registerPushDevice(
  db: Database,
  input: RegisterPushDeviceInput,
): Promise<RegisterPushDeviceResult> {
  const ownershipProof = or(
    eq(communityPushDevice.userId, input.userId),
    eq(communityPushDevice.providerTokenHash, input.providerTokenHash),
    input.previousProviderTokenHash
      ? eq(
          communityPushDevice.providerTokenHash,
          input.previousProviderTokenHash,
        )
      : undefined,
  );

  const rows = await db
    .insert(communityPushDevice)
    .values({
      userId: input.userId,
      installationId: input.installationId,
      platform: input.platform,
      providerEnvironment: input.providerEnvironment,
      providerTokenEncrypted: input.providerTokenEncrypted,
      providerTokenHash: input.providerTokenHash,
      appVersion: input.appVersion ?? null,
      lastSeenAt: input.now,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: communityPushDevice.installationId,
      set: {
        userId: input.userId,
        platform: input.platform,
        providerEnvironment: input.providerEnvironment,
        providerTokenEncrypted: input.providerTokenEncrypted,
        providerTokenHash: input.providerTokenHash,
        appVersion: input.appVersion ?? null,
        lastSeenAt: input.now,
        disabledAt: null,
        updatedAt: input.now,
      },
      setWhere: ownershipProof,
    })
    .returning(metadataProjection);

  const device = rows[0];
  if (!device) return { ok: false, reason: "ownership-conflict" };

  return {
    ok: true,
    device: {
      ...device,
      platform: device.platform as PushDevicePlatform,
      providerEnvironment:
        device.providerEnvironment as PushProviderEnvironment,
    },
  };
}

export async function disablePushDevice(
  db: Database,
  input: { userId: string; installationId: string; now: string },
): Promise<boolean> {
  const rows = await db
    .update(communityPushDevice)
    .set({ disabledAt: input.now, updatedAt: input.now })
    .where(
      and(
        eq(communityPushDevice.userId, input.userId),
        eq(communityPushDevice.installationId, input.installationId),
        isNull(communityPushDevice.disabledAt),
      ),
    )
    .returning({ id: communityPushDevice.id });

  return rows.length > 0;
}

export async function listActivePushDevices(
  db: Database,
  userId: string,
): Promise<ActivePushDevice[]> {
  const rows = await db
    .select({
      id: communityPushDevice.id,
      installationId: communityPushDevice.installationId,
      platform: communityPushDevice.platform,
      providerEnvironment: communityPushDevice.providerEnvironment,
      providerTokenEncrypted: communityPushDevice.providerTokenEncrypted,
    })
    .from(communityPushDevice)
    .where(
      and(
        eq(communityPushDevice.userId, userId),
        isNull(communityPushDevice.disabledAt),
      ),
    )
    .orderBy(
      asc(communityPushDevice.createdAt),
      asc(communityPushDevice.id),
    );

  return rows.map((row) => ({
    ...row,
    platform: row.platform as PushDevicePlatform,
    providerEnvironment:
      row.providerEnvironment as PushProviderEnvironment,
  }));
}
