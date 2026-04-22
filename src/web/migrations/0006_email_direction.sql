-- Add direction column to emails table (inbound/outbound)
ALTER TABLE emails ADD COLUMN direction TEXT NOT NULL DEFAULT 'inbound';

-- Backfill: emails sent FROM an @alook.ai address are outbound
UPDATE emails SET direction = 'outbound' WHERE from_email LIKE '%@alook.ai';
