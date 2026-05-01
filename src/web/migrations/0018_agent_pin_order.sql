-- Add order column to agent_pin for drag-and-drop reordering
ALTER TABLE agent_pin ADD COLUMN "order" integer NOT NULL DEFAULT 0;
