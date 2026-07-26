-- Per-bot LLM model selection — one narrow nullable column on the bot binding.
-- See plans/community-bot-model-sync.md (TODO 5).
--
-- `model_name` is the full launchable model id (e.g. "claude-opus-4-6"), or
-- NULL for the runtime's own default. The ModelConfig `kind`
-- (default / named / custom) is DERIVED from the runtime's catalog at read
-- time (see src/shared/src/community/bot-model.ts) and is NEVER stored:
-- deriving at read time always reflects the current catalog, whereas a
-- persisted kind would freeze a catalog-membership verdict.
--
-- NULL ⇒ { kind: "default" }, which is byte-identical to the config every bot
-- receives today, so this migration is behaviorally INERT for existing rows.
-- No index — the column is never filtered on.
--
-- SQLite has no `ADD COLUMN IF NOT EXISTS`; this statement is NOT idempotent.

ALTER TABLE community_bot_binding ADD COLUMN model_name TEXT;
