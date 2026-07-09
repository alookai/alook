-- Add a 4-digit `discriminator` to every user for `name#0042`-style
-- disambiguation in the UserCard and friend-search picker.
--
-- New rows get an FNV-1a hash of user.id at INSERT time via the Better-Auth
-- `user.create.before` hook (see computeDiscriminator in @alook/shared).
--
-- Existing rows are seeded with a random 4-digit tag right here in SQL so we
-- don't ship a screenful of `#0000` on day one. The stored value is opaque —
-- nothing recomputes it from the id and compares — so random is fine.
ALTER TABLE user ADD COLUMN discriminator TEXT NOT NULL DEFAULT '0000';
UPDATE user SET discriminator = printf('%04d', abs(random()) % 10000);
