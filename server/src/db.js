'use strict';

// Database setup: opening, versioned migrations, and backups.
//
// Migrations are the numbered .sql files in ./migrations. The number of the
// last one applied is stored in SQLite's `user_version` pragma. On startup any
// pending migrations run in order, each inside a transaction, and a backup of
// the database is taken first. Since watchtower deploys new images unattended,
// this is what keeps a schema change from ever meeting a database it can't
// handle, or losing data if a migration is wrong.

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .map((f) => ({ version: parseInt(f, 10), file: f }))
    .sort((a, b) => a.version - b.version);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Online backup: safe while the server is running and writing.
async function backup(db, backupDir, label) {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, `tapewrangler-${timestamp()}-${label}.db`);
  await db.backup(dest);
  return dest;
}

// Delete the oldest backups with the given label beyond `keep`.
function pruneBackups(backupDir, label, keep) {
  if (!fs.existsSync(backupDir)) return;
  const files = fs.readdirSync(backupDir)
    .filter((f) => f.endsWith(`-${label}.db`))
    .sort(); // timestamps sort lexically
  for (const f of files.slice(0, Math.max(0, files.length - keep))) {
    fs.unlinkSync(path.join(backupDir, f));
  }
}

async function openDatabase({ dataDir, log = console.log }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'tapewrangler.db');
  const backupDir = path.join(dataDir, 'backups');
  const existed = fs.existsSync(dbPath);

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  const current = db.pragma('user_version', { simple: true });
  const migrations = listMigrations();
  const latest = migrations.length ? migrations[migrations.length - 1].version : 0;
  const pending = migrations.filter((m) => m.version > current);

  if (current > latest) {
    // An older image was started against a newer database (e.g. a rollback).
    // Refuse rather than guess; the pre-migration backup is the way back.
    throw new Error(
      `Database schema is v${current} but this build only knows up to v${latest}. ` +
      `Run a newer image, or restore a backup from ${backupDir}.`);
  }

  if (pending.length && existed && current > 0) {
    const dest = await backup(db, backupDir, `pre-v${pending[pending.length - 1].version}`);
    log(`Backed up database before migrating: ${dest}`);
  }

  for (const m of pending) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, m.file), 'utf8');
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    log(`Applied migration ${m.file}`);
  }

  return { db, dbPath, backupDir };
}

module.exports = { openDatabase, backup, pruneBackups, listMigrations };
