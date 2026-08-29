ALTER TABLE community_machine
ADD COLUMN time_zone TEXT
CHECK (
  time_zone IS NULL
  OR length(time_zone) BETWEEN 1 AND 128
);
