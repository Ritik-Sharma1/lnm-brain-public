CREATE TABLE IF NOT EXISTS hermes_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
  turn_index REAL NOT NULL, role TEXT NOT NULL CHECK(role IN ('user','assistant','system')),
  content TEXT NOT NULL, model_used TEXT, platform TEXT DEFAULT 'hermes',
  project_id TEXT DEFAULT '', tokens_approx INTEGER,
  created_at TEXT DEFAULT (datetime('now')), processed INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_hermes_turns_session ON hermes_turns(session_id,turn_index);
CREATE INDEX IF NOT EXISTS idx_hermes_turns_unprocessed ON hermes_turns(processed,session_id);
CREATE TABLE IF NOT EXISTS hermes_skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT, skill_name TEXT NOT NULL, task_type TEXT NOT NULL,
  model_used TEXT, outcome TEXT CHECK(outcome IN ('success','partial','fail')),
  notes TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_hermes_skills_name ON hermes_skills(skill_name,outcome);
CREATE TABLE IF NOT EXISTS hermes_dreams (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, project_id TEXT DEFAULT '',
  turns_processed INTEGER DEFAULT 0, facts_extracted INTEGER DEFAULT 0,
  tensions_found INTEGER DEFAULT 0, model_used TEXT, summary TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_hermes_dreams_session ON hermes_dreams(session_id);
