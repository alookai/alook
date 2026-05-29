-- Migration for Issue #211: RFC 2047 encoded subjects
--
-- Problem: CF Email Routing path stored raw RFC 2047 encoded subjects
-- (e.g. "=?UTF-8?q?Re:_=E6=96=B0...?=") instead of decoded Unicode.
--
-- Fix: The code now prioritizes parsed.subject (decoded by postal-mime)
-- over the raw message header. New emails will be stored correctly.
--
-- Existing data: RFC 2047 decoding requires charset-aware hex/base64
-- decoding which SQLite cannot perform in pure SQL. Affected rows are
-- cosmetic-only and will self-correct as conversations continue.
-- If bulk correction is needed, use an application-level script that
-- re-parses from R2-stored raw emails.

SELECT 1;
