interface Env {
  WS_DO_WORKER: Fetcher
  /**
   * `alook-app` — the same D1 database `src/web/wrangler.toml` binds as
   * `DB` (minimal-wake-queue-unread-notice plan §3). The consumer reads
   * current message/bot/binding/read-state rows here to rebuild the
   * `agent:wake` command at consume time (`buildUnreadWakeCommand`).
   */
  DB: D1Database
}
