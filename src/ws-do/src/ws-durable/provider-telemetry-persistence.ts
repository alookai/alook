import type {
  DailyUsageSnapshot,
  ProviderQuotaSnapshot,
} from "@alook/shared";

const USAGE_UPSERT_SQL = `
  INSERT INTO community_bot_daily_token_usage (
    bot_id, day,
    input_tokens, output_tokens, cache_tokens,
    updated_at
  )
  SELECT ?, ?, ?, ?, ?, ?
  WHERE EXISTS (
    SELECT 1 FROM community_bot_binding
    WHERE user_id = ? AND machine_id = ?
  )
  ON CONFLICT(bot_id, day) DO UPDATE SET
    input_tokens = excluded.input_tokens,
    output_tokens = excluded.output_tokens,
    cache_tokens = excluded.cache_tokens,
    updated_at = excluded.updated_at`;

const QUOTA_REPLACE_SQL = `
  INSERT INTO community_machine_backend_quota (
    machine_id, agent_backend_id, source_epoch, status, plan_name,
    fresh_for_seconds, limits, error_code, retryable, observed_at, updated_at
  )
  SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
  FROM community_machine
  WHERE id = ? AND user_id = ?
  ON CONFLICT(machine_id, agent_backend_id) DO UPDATE SET
    source_epoch = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.source_epoch ELSE excluded.source_epoch END,
    status = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.status ELSE excluded.status END,
    plan_name = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.plan_name ELSE excluded.plan_name END,
    fresh_for_seconds = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.fresh_for_seconds ELSE excluded.fresh_for_seconds END,
    limits = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.limits ELSE excluded.limits END,
    error_code = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.error_code ELSE excluded.error_code END,
    retryable = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.retryable ELSE excluded.retryable END,
    observed_at = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.observed_at ELSE excluded.observed_at END,
    updated_at = CASE WHEN community_machine_backend_quota.source_epoch = excluded.source_epoch AND community_machine_backend_quota.status = 'available' AND excluded.status = 'error' THEN community_machine_backend_quota.updated_at ELSE excluded.updated_at END`;

export function prepareUsageUpsert(
  db: D1Database,
  machineId: string,
  snapshot: DailyUsageSnapshot,
  nowIso: string,
): D1PreparedStatement {
  return db.prepare(USAGE_UPSERT_SQL).bind(
    snapshot.botId,
    snapshot.day,
    snapshot.metrics.input,
    snapshot.metrics.output,
    snapshot.metrics.cache,
    nowIso,
    snapshot.botId,
    machineId,
  );
}

export function prepareUsagePrune(
  db: D1Database,
  machineId: string,
  botId: string,
  oldestDay: string,
): D1PreparedStatement {
  return db.prepare(`
    DELETE FROM community_bot_daily_token_usage
    WHERE bot_id = ? AND day < ?
      AND EXISTS (
        SELECT 1 FROM community_bot_binding
        WHERE user_id = ? AND machine_id = ?
      )
  `).bind(botId, oldestDay, botId, machineId);
}

export function prepareMachineTimeZoneUpdate(
  db: D1Database,
  identity: { machineId: string; userId: string },
  timeZone: string,
): D1PreparedStatement {
  return db.prepare(`
    UPDATE community_machine
    SET time_zone = ?
    WHERE id = ? AND user_id = ?
  `).bind(timeZone, identity.machineId, identity.userId);
}

export function prepareQuotaReplace(
  db: D1Database,
  identity: { machineId: string; userId: string },
  snapshot: ProviderQuotaSnapshot,
  nowIso: string,
): D1PreparedStatement {
  const observation = snapshot.observation;
  return db.prepare(QUOTA_REPLACE_SQL).bind(
    identity.machineId,
    snapshot.agentBackendId,
    observation.sourceEpoch,
    observation.status,
    observation.status === "available" ? observation.planName ?? null : null,
    observation.status === "available" ? observation.freshForSeconds : null,
    observation.status === "available" ? JSON.stringify(observation.limits) : null,
    observation.status === "error" ? observation.code : null,
    observation.status === "error" ? (observation.retryable ? 1 : 0) : null,
    nowIso,
    nowIso,
    identity.machineId,
    identity.userId,
  );
}

export function prepareActivityProfileUpsert(
  db: D1Database,
  machineId: string,
  botId: string,
  statusEmoji: string | null,
  statusText: string | null,
): D1PreparedStatement {
  return db.prepare(`
    INSERT INTO community_user_profile (user_id, about_me, banner_color, status_emoji, status_text)
    SELECT ?, '', NULL, ?, ?
    WHERE EXISTS (
      SELECT 1 FROM community_bot_binding
      WHERE user_id = ? AND machine_id = ?
    )
    ON CONFLICT(user_id) DO UPDATE SET
      status_emoji = excluded.status_emoji,
      status_text = excluded.status_text
  `).bind(botId, statusEmoji, statusText ?? "", botId, machineId);
}
