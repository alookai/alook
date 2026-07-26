-- Heal workspace slugs that predate server-side sanitization.
-- A slug is a URL path segment (/w/{slug}); any char outside [a-z0-9-]
-- (spaces, uppercase, unicode, symbols, '_') breaks the invariant. SQLite has
-- no regex replace and a partial transform risks UNIQUE(slug) collisions, so we
-- regenerate illegal slugs to a guaranteed-safe, collision-free 'company-<hex>'
-- value. Owners can set a readable slug in settings after.
-- GLOB is case-sensitive, so uppercase letters ARE caught by [^a-z0-9-]; the
-- trailing '-' in the class is a literal and is correctly allowed.
-- Idempotent: clean slugs never match the WHERE, so re-running is a no-op.
UPDATE workspace
SET slug = 'company-' || lower(hex(randomblob(4))),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE slug GLOB '*[^a-z0-9-]*';
