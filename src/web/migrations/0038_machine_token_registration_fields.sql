-- Add hostname and runtimes_json columns to machine_token table
-- for storing machine registration data before workspace binding
ALTER TABLE machine_token ADD COLUMN hostname TEXT;
ALTER TABLE machine_token ADD COLUMN runtimes_json TEXT;
