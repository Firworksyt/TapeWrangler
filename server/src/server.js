'use strict';

// Entry point: reads configuration from the environment, opens the database,
// starts the HTTP server and the automatic backup schedule.
//
//   PORT                    HTTP port (default 3000)
//   DATA_DIR                where the database and backups live (default ./data)
//   TAPEWRANGLER_TOKEN      if set, required (as a Bearer token) for any change
//   BACKUP_INTERVAL_HOURS   hours between automatic backups (default 24, 0 = off)
//   BACKUP_KEEP             automatic backups to keep (default 14)
//   MAX_UPLOAD              largest accepted file list upload (default 512mb)

const fs = require('fs');
const path = require('path');
const { openDatabase, backup, pruneBackups } = require('./db');
const { createApp } = require('./app');
const pkg = require('../package.json');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const TOKEN = (process.env.TAPEWRANGLER_TOKEN || '').trim();
const BACKUP_INTERVAL_HOURS = Number(process.env.BACKUP_INTERVAL_HOURS ?? 24);
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 14;

function newestBackupAge(backupDir, label) {
  if (!fs.existsSync(backupDir)) return Infinity;
  const newest = fs.readdirSync(backupDir).filter((f) => f.endsWith(`-${label}.db`)).sort().pop();
  if (!newest) return Infinity;
  return Date.now() - fs.statSync(path.join(backupDir, newest)).mtimeMs;
}

// Checks hourly and backs up once the newest automatic backup is older than the
// interval. This way frequent container restarts don't pile up backups, and a
// long downtime doesn't skip one.
function scheduleBackups(db, backupDir) {
  if (!(BACKUP_INTERVAL_HOURS > 0)) {
    console.log('Automatic backups are off (BACKUP_INTERVAL_HOURS=0)');
    return;
  }
  const intervalMs = BACKUP_INTERVAL_HOURS * 3600 * 1000;
  const check = async () => {
    try {
      if (newestBackupAge(backupDir, 'auto') >= intervalMs) {
        const dest = await backup(db, backupDir, 'auto');
        pruneBackups(backupDir, 'auto', BACKUP_KEEP);
        console.log(`Automatic backup written: ${dest}`);
      }
    } catch (e) {
      console.error('Automatic backup failed:', e);
    }
  };
  setTimeout(check, 60 * 1000).unref();
  setInterval(check, 3600 * 1000).unref();
}

async function main() {
  const { db, dbPath, backupDir } = await openDatabase({ dataDir: DATA_DIR });
  const version = {
    version: pkg.version,
    commit: process.env.COMMIT_HASH || 'unknown',
    built: process.env.BUILD_TIMESTAMP || null,
    schema: db.pragma('user_version', { simple: true }),
  };
  const app = createApp({ db, backupDir, token: TOKEN, version, backupKeep: BACKUP_KEEP });

  const server = app.listen(PORT, () => {
    console.log(`TapeWrangler ${pkg.version} (${version.commit.slice(0, 7)}) on port ${PORT}`);
    console.log(`Database: ${dbPath}`);
    if (!TOKEN) {
      console.warn('TAPEWRANGLER_TOKEN is not set: anyone who can reach this server can change the catalog.');
    }
  });
  scheduleBackups(db, backupDir);

  const shutdown = () => {
    server.close(() => {
      db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
