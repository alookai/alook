CREATE TABLE IF NOT EXISTS issue_comment (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issue(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  author_type TEXT NOT NULL DEFAULT 'user',
  author_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_issue_comment_issue
  ON issue_comment(issue_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issue_comment_workspace
  ON issue_comment(workspace_id, issue_id);
