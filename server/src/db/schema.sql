CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  title TEXT NOT NULL,
  answer_mode TEXT NOT NULL DEFAULT 'ink',
  settings_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (host_id) REFERENCES hosts(id)
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  position INTEGER NOT NULL,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'ink',
  prompt TEXT NOT NULL,
  options_json TEXT,
  correct_answer TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 1,
  time_limit_seconds INTEGER NOT NULL DEFAULT 15,
  position INTEGER NOT NULL,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  join_code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  phase TEXT NOT NULL DEFAULT 'DRAFT',
  current_category_id TEXT,
  current_question_id TEXT,
  question_ends_at INTEGER,
  spotlight_team_id TEXT,
  started_at INTEGER,
  ended_at INTEGER,
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,
  device_token TEXT NOT NULL,
  team_pin TEXT NOT NULL,
  answer_mode TEXT NOT NULL DEFAULT 'ink',
  status TEXT NOT NULL DEFAULT 'connected',
  joined_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  question_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  answer_ink TEXT,
  answer_raw TEXT,
  submitted_at INTEGER NOT NULL,
  is_correct INTEGER, -- NULL = unmarked, 1 = true, 0 = false
  is_hidden INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, question_id, team_id),
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (question_id) REFERENCES questions(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE TABLE IF NOT EXISTS score_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  question_id TEXT,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id),
  FOREIGN KEY (team_id) REFERENCES teams(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_code ON sessions(join_code);
CREATE INDEX IF NOT EXISTS idx_teams_session_device ON teams(session_id, device_token);
CREATE INDEX IF NOT EXISTS idx_submissions_session_q ON submissions(session_id, question_id);
