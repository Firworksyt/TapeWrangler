-- Initial schema.

CREATE TABLE locations (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE tapes (
  id               INTEGER PRIMARY KEY,
  barcode          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name             TEXT NOT NULL DEFAULT '',
  location_id      INTEGER REFERENCES locations(id) ON DELETE RESTRICT,
  generation       TEXT NOT NULL DEFAULT 'LTO-6',
  capacity_bytes   INTEGER,              -- NULL = use the generation's native capacity
  status           TEXT NOT NULL DEFAULT 'active', -- active | full | offsite | retired
  notes            TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_indexed_at  TEXT,
  last_verified_at TEXT,
  last_verify_ok   INTEGER,              -- 1 = passed, 0 = problems found, NULL = never verified
  file_count       INTEGER NOT NULL DEFAULT 0, -- cached, recomputed after each import
  used_bytes       INTEGER NOT NULL DEFAULT 0  -- cached, recomputed after each import
);
CREATE INDEX tapes_location ON tapes(location_id);

CREATE TABLE files (
  id        INTEGER PRIMARY KEY,
  tape_id   INTEGER NOT NULL REFERENCES tapes(id) ON DELETE CASCADE,
  path      TEXT NOT NULL,               -- relative to the tape root, '/' separated
  dir       TEXT NOT NULL,               -- parent directory of path ('' for the root)
  size      INTEGER NOT NULL,
  mtime     INTEGER,                     -- unix seconds
  sha256    TEXT,
  UNIQUE (tape_id, path)
);
CREATE INDEX files_tape_dir ON files(tape_id, dir);
CREATE INDEX files_path_size ON files(path, size);

-- Substring search over paths. The trigram tokenizer makes "foo" match
-- anywhere inside a path, case-insensitively, without scanning every row.
CREATE VIRTUAL TABLE files_fts USING fts5(
  path, content='files', content_rowid='id', tokenize='trigram'
);
CREATE TRIGGER files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, path) VALUES (new.id, new.path);
END;
CREATE TRIGGER files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, path) VALUES ('delete', old.id, old.path);
END;
CREATE TRIGGER files_au AFTER UPDATE OF path ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, path) VALUES ('delete', old.id, old.path);
  INSERT INTO files_fts(rowid, path) VALUES (new.id, new.path);
END;

-- One row per upload of a file list, so each tape has a history.
CREATE TABLE imports (
  id          INTEGER PRIMARY KEY,
  tape_id     INTEGER NOT NULL REFERENCES tapes(id) ON DELETE CASCADE,
  mode        TEXT NOT NULL,             -- replace | append
  source      TEXT NOT NULL DEFAULT '',  -- free text, e.g. "cli index" or "cli write ~/photos"
  file_count  INTEGER NOT NULL,
  total_bytes INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX imports_tape ON imports(tape_id);
