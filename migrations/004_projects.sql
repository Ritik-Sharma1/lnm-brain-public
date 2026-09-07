CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client TEXT, voice_notes TEXT,
  status TEXT DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_hermes_turns_project  ON hermes_turns(project_id,session_id,turn_index);
CREATE INDEX IF NOT EXISTS idx_hermes_dreams_project ON hermes_dreams(project_id);
