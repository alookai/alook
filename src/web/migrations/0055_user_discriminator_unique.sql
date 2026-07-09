-- The `(name, discriminator)` pair is now load-bearing for routing: DM refs
-- (`/.dm/name#0042`) and mentions (`@Name#0042`) resolve a handle to exactly
-- one user, so it must be unique among live users. Partial index (excludes
-- soft-deleted rows) so a deleted user's old handle can be reissued.
-- `name COLLATE NOCASE` matches the case-insensitive `like(user.name, ...)`
-- lookups in queries/user.ts (getUserByNameAndDiscriminator etc.) — without
-- it, "Alice#0042" and "alice#0042" could both exist as live rows (the
-- byte-for-byte-unique index wouldn't reject the second insert), and a
-- case-insensitive handle lookup would then match two rows nondeterministically.
CREATE UNIQUE INDEX idx_user_name_discriminator ON user(name COLLATE NOCASE, discriminator) WHERE deletedAt IS NULL;
