CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
  source_kind TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL,
  source_label TEXT NOT NULL, reading_status TEXT NOT NULL DEFAULT 'unread'
    CHECK(reading_status IN ('unread','reading','read'))
);
CREATE INDEX IF NOT EXISTS lesson_course ON lessons(course_id, ordinal);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, job_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('chat','quiz','grade')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','done','failed','interrupted')),
  stage TEXT NOT NULL, error TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '{}',
  payload TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_job ON jobs(lesson_id,kind) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  tool TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exercises (
  id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  question TEXT NOT NULL, reference_answer TEXT NOT NULL, rubric TEXT NOT NULL,
  student_answer TEXT NOT NULL DEFAULT '', score INTEGER CHECK(score BETWEEN 0 AND 100),
  feedback TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'waiting_answer',
  created_at INTEGER NOT NULL, job_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS video_tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT NOT NULL, options TEXT NOT NULL,
  status TEXT NOT NULL, stage TEXT NOT NULL DEFAULT '', percent INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '', out_dir TEXT NOT NULL DEFAULT '', course_id TEXT NOT NULL DEFAULT '',
  cancel_requested INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS learning_plans (
  id TEXT PRIMARY KEY, course_id TEXT NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  title TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_model','failed','interrupted','draft','active','completed')),
  daily_minutes INTEGER NOT NULL DEFAULT 30, start_date TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '', error TEXT NOT NULL DEFAULT '', result TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS plan_tasks (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES learning_plans(id) ON DELETE CASCADE,
  unit_index INTEGER NOT NULL, lesson_id TEXT NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('study','review')), title TEXT NOT NULL,
  minutes INTEGER NOT NULL, due_date TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0 CHECK(done IN (0,1)),
  ordinal INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_task_order ON plan_tasks(plan_id, ordinal);
CREATE TABLE IF NOT EXISTS exercise_ink (
  exercise_id TEXT PRIMARY KEY REFERENCES exercises(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0, document TEXT NOT NULL,
  recognized_text TEXT NOT NULL DEFAULT '', recognized_revision INTEGER NOT NULL DEFAULT -1
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  course_id TEXT REFERENCES courses(id) ON DELETE SET NULL,
  text TEXT NOT NULL DEFAULT '',
  document TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_updated ON notes(archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_course ON notes(course_id);
