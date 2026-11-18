export const COMMUNITY_MACHINE_HEARTBEAT_MS = 30_000;
export const COMMUNITY_MACHINE_OFFLINE_THRESHOLD_MS = 3 * COMMUNITY_MACHINE_HEARTBEAT_MS;
export const COMMUNITY_MACHINE_PAIR_TOKEN_TTL_MS = 15 * 60_000;
// Transport/schema safety ceiling for one community bot collection in a
// request. This is NOT the owner's product-plan limit; business capacity is
// resolved from the generic `bots.max` entitlement.
export const COMMUNITY_BOT_REQUEST_MAX_ITEMS = 100;
// Display-line-fit at 375 px mobile width.
export const COMMUNITY_BOT_NAME_MIN = 1;
export const COMMUNITY_BOT_NAME_MAX = 32;
// Prompt-size sanity; system prompts embed this verbatim.
export const COMMUNITY_BOT_DESCRIPTION_MAX = 1024;
// HTTP URL bounds.
export const COMMUNITY_BOT_IMAGE_URL_MAX = 2048;
// Synthetic email — bots never sign in (no session mint), but Better-Auth
// requires a unique email on the user row. `bots.alook.local` is a reserved
// non-routable local domain.
export const COMMUNITY_BOT_EMAIL_DOMAIN = "bots.alook.local";
export const COMMUNITY_BOT_EMAIL_PREFIX = "bot-";

/**
 * Single source of truth for constructing a bot's synthetic email.
 * Always lowercased before insert — Better-Auth lowercases inputs and the
 * underlying `user.email` unique index is case-sensitive at the DB layer.
 */
export function communityBotSyntheticEmail(userId: string): string {
  return `${COMMUNITY_BOT_EMAIL_PREFIX}${userId}@${COMMUNITY_BOT_EMAIL_DOMAIN}`.toLowerCase();
}

/**
 * Synthetic friendship id used for owner ↔ own-bot rows in `listFriends`.
 * Bots never have a real `communityFriendship` row with their owner — they
 * ARE the owner's friend by construction. The `self-bot:` prefix flags the
 * row as synthetic so UI code (e.g. remove-friend, block) can skip it.
 *
 * Lives here (not in the db/queries layer) so client-side components can
 * import it without pulling drizzle-orm into the browser bundle.
 */
export const SELF_BOT_FRIENDSHIP_PREFIX = "self-bot:";
export function isSelfBotFriendship(id: string): boolean {
  return id.startsWith(SELF_BOT_FRIENDSHIP_PREFIX);
}

export const DEV_PASSWORD = "dev-password-000";

/**
 * Shape shared by every "which port does each service run on" profile in the
 * monorepo — the monorepo-local dev profile below (`DEV_PORTS`) and the
 * self-hosted `@alook/app` profile (`DEFAULT_PORTS` in
 * src/app/src/lib/constants.ts, which uses the 1521x range so it doesn't
 * collide with a developer's own `pnpm dev` checkout). Same format, two
 * separate value sets on purpose.
 */
export interface DevPortProfile {
  web: number;
  emailWorker: number;
  wsDo: number;
  queueWorker: number;
}

// Ports used by `pnpm dev:*` / `wrangler dev` in this monorepo — must match
// each worker's wrangler.toml `[dev] port` (web via Next, queue-worker via
// src/queue-worker/wrangler.toml). Single source of truth for the fallback
// URLs below and every other hardcoded dev-port default across web/cli/daemon.
export const DEV_PORTS: DevPortProfile = {
  web: 3000,
  emailWorker: 8787,
  wsDo: 8789,
  queueWorker: 8790,
};

export const DEV_WEB_URL = process.env.ALOOK_SERVER_URL || `http://localhost:${DEV_PORTS.web}`;
export const DEV_WS_DO_URL = process.env.DEV_WS_DO_URL || `http://localhost:${DEV_PORTS.wsDo}`;
export const DEV_EMAIL_WORKER_URL = process.env.DEV_EMAIL_WORKER_URL || `http://localhost:${DEV_PORTS.emailWorker}`;
export const DEV_QUEUE_WORKER_URL = process.env.DEV_QUEUE_WORKER_URL || `http://localhost:${DEV_PORTS.queueWorker}`;

export function devWsDoPort(): number {
  const port = Number(new URL(DEV_WS_DO_URL).port);
  return port || DEV_PORTS.wsDo;
}
