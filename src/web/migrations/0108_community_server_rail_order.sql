CREATE TABLE community_server_rail (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  entries TEXT NOT NULL
);
