ALTER TABLE automation_access_code ADD COLUMN purpose TEXT CHECK (purpose IS NULL OR purpose = 'onboarding');
CREATE UNIQUE INDEX idx_automation_code_owner_purpose ON automation_access_code (owner_id, purpose);
