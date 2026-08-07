-- Add a 4-digit `discriminator` to every community server for `name#0042`-style
-- disambiguation, mirroring the user discriminator (migration 0051). This is
-- the server-segment address anchor: a ref `/name#disc/channel` must resolve to
-- exactly one server, which requires `(name, discriminator)` uniqueness. The
-- unique index lands in 0080 (split from the seed so the census prerequisite
-- can run against remote between the two, same as user 0051 -> 0055).
--
-- New rows get an FNV-1a hash of community_server.id at INSERT time via
-- createServer's `withUniqueDiscriminator` wrap (see computeDiscriminator in
-- @alook/shared) — hash on the immutable id, not the name, so renames don't
-- rotate the tag.
--
-- Existing rows are seeded with a random 4-digit tag right here in SQL so we
-- don't ship a screenful of `#0000` on day one. The stored value is OPAQUE —
-- nothing recomputes it from the id and compares — so random is fine (identical
-- rationale to user 0051). Two same-name servers CAN draw the same random tag;
-- the 0080 unique index's census prerequisite catches and resolves that before
-- the index builds.
ALTER TABLE community_server ADD COLUMN discriminator TEXT NOT NULL DEFAULT '0000';
UPDATE community_server SET discriminator = printf('%04d', abs(random()) % 10000);
