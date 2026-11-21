CREATE TABLE IF NOT EXISTS community_question_todo (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES community_message(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL REFERENCES community_channel(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  dismissed_at TEXT,
  PRIMARY KEY (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_community_question_todo_user_active
  ON community_question_todo (user_id, created_at DESC, message_id DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_community_question_todo_message_id_lookup
  ON community_question_todo (message_id);

CREATE INDEX IF NOT EXISTS idx_community_question_todo_channel_id_lookup
  ON community_question_todo (channel_id);

INSERT OR IGNORE INTO community_question_todo (user_id, message_id, channel_id, created_at, dismissed_at)
SELECT
  CASE WHEN assignee.type = 'object' THEN json_extract(assignee.value, '$.userId') END AS user_id,
  m.id AS message_id,
  m.channel_id AS channel_id,
  m.created_at AS created_at,
  NULL AS dismissed_at
FROM (
  SELECT id, author_id, channel_id, created_at, embeds
  FROM community_message
  WHERE type = 'question'
    AND embeds IS NOT NULL
    AND json_valid(embeds) = 1
    AND json_type(embeds) = 'array'
) m
JOIN json_each(m.embeds) embed
JOIN json_each(
  CASE
    WHEN embed.type = 'object'
      AND json_extract(embed.value, '$.kind') = 'decision_card'
      AND json_type(embed.value, '$.assignees') = 'array'
    THEN json_extract(embed.value, '$.assignees')
    ELSE '[]'
  END
) assignee
WHERE assignee.type = 'object'
  AND CASE WHEN assignee.type = 'object' THEN json_type(assignee.value, '$.userId') END = 'text'
  AND CASE WHEN assignee.type = 'object' THEN json_extract(assignee.value, '$.userId') END != m.author_id
  AND EXISTS (
    SELECT 1 FROM user u
    WHERE u.id = CASE WHEN assignee.type = 'object' THEN json_extract(assignee.value, '$.userId') END
  );
