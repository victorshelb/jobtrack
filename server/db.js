const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.JOBTRACK_DATA || path.join(__dirname, '..', 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(FILES_DIR, { recursive: true, mode: 0o700 });
fs.chmodSync(DATA_DIR, 0o700); // personal data: owner-only

const db = new DatabaseSync(path.join(DATA_DIR, 'jobtrack.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')), expires_at TEXT
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'cv',            -- cv | cover_letter | other
  title TEXT NOT NULL,
  parent_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  filename TEXT, mime TEXT, path TEXT,        -- original uploaded file (optional)
  text TEXT DEFAULT '',                       -- extracted / edited text (markdown-ish)
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT '',
  url TEXT DEFAULT '',
  source TEXT DEFAULT '',
  location TEXT DEFAULT '',
  salary TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft',       -- draft|applied|screening|interview|offer|rejected|ghosted|withdrawn
  applied_at TEXT,
  status_updated_at TEXT DEFAULT (datetime('now')),
  follow_up_at TEXT,
  jd_text TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  contact_name TEXT DEFAULT '',
  contact_email TEXT DEFAULT '',
  referral TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS app_documents (
  app_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  doc_id INTEGER REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (app_id, doc_id)
);

CREATE TABLE IF NOT EXISTS status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  status TEXT, at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,  -- NULL = answer bank entry
  question TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER REFERENCES applications(id) ON DELETE CASCADE,
  doc_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                          -- rejection|pre_submit|tailor|interview_prep|patterns|answer
  engine TEXT,                                 -- claude-cli | manual
  status TEXT DEFAULT 'done',                  -- running|done|error
  result TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Migrations for databases created by older versions
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('applications').includes('status_manual_at')) db.exec(`ALTER TABLE applications ADD COLUMN status_manual_at TEXT`);
if (!cols('applications').includes('logo_url')) db.exec(`ALTER TABLE applications ADD COLUMN logo_url TEXT DEFAULT ''`);

const getSetting = (k) => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) =>
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, v);

module.exports = { db, DATA_DIR, FILES_DIR, getSetting, setSetting };
