ALTER TABLE community_server ADD COLUMN official INTEGER NOT NULL DEFAULT 0 CHECK (official IN (0, 1));
