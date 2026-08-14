ALTER TABLE community_bot_binding ADD COLUMN instruction TEXT NOT NULL DEFAULT '';

UPDATE community_bot_binding
SET instruction = COALESCE(
  (
    SELECT community_user_profile.about_me
    FROM community_user_profile
    WHERE community_user_profile.user_id = community_bot_binding.user_id
  ),
  ''
);
