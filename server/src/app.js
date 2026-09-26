'use strict';

// HTTP API and static UI. `createApp` takes an open database so tests can run
// against a throwaway one.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { parseFileList } = require('./importer');
const { backup, pruneBackups } = require('./db');

// Native (uncompressed) capacities in bytes. LTFS formatting reserves a little
// of this, so a "full" tape will read slightly under 100%.
const GENERATIONS = {
  'LTO-5': 1.5e12,
  'LTO-6': 2.5e12,
  'LTO-7': 6e12,
  'LTO-M8': 9e12,
  'LTO-8': 12e12,
  'LTO-9': 18e12,
  'LTO-10': 30e12,
  'Other': null,
};
const STATUSES = ['active', 'full', 'offsite', 'retired'];
const BARCODE_RE = /^[A-Za-z0-9._-]{1,32}$/;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Express 5 forwards rejected promises to the error handler; this keeps
// handlers working the same way on Express 4.
const wrap = (fn) => (req, res, next) => {
  try {
    const r = fn(req, res, next);
    if (r && typeof r.catch === 'function') r.catch(next);
  } catch (e) {
    next(e);
  }
};

function now() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function createApp({ db, backupDir, token = '', version = {}, backupKeep = 14 }) {
  const app = express();
  app.disable('x-powered-by');

  // ---------------------------------------------------------------- helpers

  const q = {
    tapeByBarcode: db.prepare('SELECT * FROM tapes WHERE barcode = ?'),
    // LTFS reports a 6-character volume serial (e.g. ABC123) while the label on
    // the cartridge usually has the media suffix too (ABC123L6).
    tapeByVolser: db.prepare(
      'SELECT * FROM tapes WHERE length(barcode) = 8 AND substr(barcode, 1, 6) = ? COLLATE NOCASE'),
    tapeStats: db.prepare(
      'SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM files WHERE tape_id = ?'),
    setTapeStats: db.prepare('UPDATE tapes SET file_count = ?, used_bytes = ? WHERE id = ?'),
    location: db.prepare('SELECT * FROM locations WHERE id = ?'),
  };

  function findTape(id) {
    const exact = q.tapeByBarcode.get(id);
    if (exact) return exact;
    if (id.length === 6) {
      const rows = q.tapeByVolser.all(id);
      if (rows.length === 1) return rows[0];
    }
    return null;
  }

  function mustTape(id) {
    const t = findTape(id);
    if (!t) throw new HttpError(404, `No tape with barcode ${id}`);
    return t;
  }

  function refreshTapeStats(tapeId) {
    const s = q.tapeStats.get(tapeId);
    q.setTapeStats.run(s.n, s.bytes, tapeId);
  }

  function capacityOf(t) {
    return t.capacity_bytes ?? GENERATIONS[t.generation] ?? null;
  }

  function tapeView(t) {
    const loc = t.location_id ? q.location.get(t.location_id) : null;
    const capacity = capacityOf(t);
    return {
      barcode: t.barcode,
      name: t.name,
      location_id: t.location_id,
      location: loc ? loc.name : null,
      generation: t.generation,
      capacity_bytes: capacity,
      capacity_is_custom: t.capacity_bytes !== null,
      status: t.status,
      notes: t.notes,
      file_count: t.file_count,
      used_bytes: t.used_bytes,
      fill: capacity ? t.used_bytes / capacity : null,
      created_at: t.created_at,
      last_indexed_at: t.last_indexed_at,
      last_verified_at: t.last_verified_at,
      last_verify_ok: t.last_verify_ok === null ? null : !!t.last_verify_ok,
    };
  }

  function cleanBarcode(v) {
    const b = String(v ?? '').trim().toUpperCase();
    if (!BARCODE_RE.test(b)) {
      throw new HttpError(400, 'Barcode must be 1-32 letters, digits, dots, dashes or underscores');
    }
    return b;
  }

  function optString(v, field, max = 500) {
    if (v === undefined) return undefined;
    if (v === null) return '';
    if (typeof v !== 'string') throw new HttpError(400, `${field} must be a string`);
    if (v.length > max) throw new HttpError(400, `${field} is too long`);
    return v.trim();
  }

  function checkLocation(id) {
    if (id === null || id === undefined || id === '') return null;
    const n = Number(id);
    if (!Number.isInteger(n) || !q.location.get(n)) throw new HttpError(400, 'Unknown location');
    return n;
  }

  function checkCapacity(v) {
    if (v === null || v === '' || v === undefined) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new HttpError(400, 'capacity_bytes must be a positive number');
    return Math.round(n);
  }

  // ------------------------------------------------------------------- auth

  const tokenBuf = token ? Buffer.from(token) : null;
  function hasValidToken(req) {
    if (!tokenBuf) return true;
    const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
    if (!m) return false;
    const given = Buffer.from(m[1].trim());
    return given.length === tokenBuf.length && crypto.timingSafeEqual(given, tokenBuf);
  }

  // Reads are open; anything that changes the catalog needs the token
  // (when TAPEWRANGLER_TOKEN is set).
  app.use('/api', (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || hasValidToken(req)) return next();
    res.status(401).json({ error: 'A valid API token is required for changes' });
  });

  // ---------------------------------------------------------------- general

  app.get('/api/version', (req, res) => res.json(version));

  app.get('/api/auth', (req, res) => {
    res.json({ required: !!tokenBuf, valid: hasValidToken(req) });
  });

  app.get('/api/generations', (req, res) => {
    res.json(Object.entries(GENERATIONS).map(([name, capacity_bytes]) => ({ name, capacity_bytes })));
  });

  // Files counted as "single copy" exist, with the same path and size, on only
  // one tape that isn't retired.
  const singleCopySql = `
    SELECT f.path, f.size, min(f.tape_id) AS tape_id
    FROM files f JOIN tapes t ON t.id = f.tape_id
    WHERE t.status != 'retired'
    GROUP BY f.path, f.size
    HAVING count(DISTINCT f.tape_id) = 1`;

  app.get('/api/stats', (req, res) => {
    const t = db.prepare(`SELECT count(*) AS tapes, coalesce(sum(file_count),0) AS files,
      coalesce(sum(used_bytes),0) AS bytes FROM tapes`).get();
    const l = db.prepare('SELECT count(*) AS n FROM locations').get();
    const s = db.prepare(`SELECT count(*) AS files, coalesce(sum(size),0) AS bytes FROM (${singleCopySql})`).get();
    res.json({
      locations: l.n, tapes: t.tapes, files: t.files, bytes: t.bytes,
      single_copy_files: s.files, single_copy_bytes: s.bytes,
    });
  });

  // -------------------------------------------------------------- locations

  app.get('/api/locations', (req, res) => {
    res.json(db.prepare(`
      SELECT l.id, l.name, l.notes, l.created_at,
             count(t.id) AS tape_count, coalesce(sum(t.used_bytes), 0) AS used_bytes
      FROM locations l LEFT JOIN tapes t ON t.location_id = l.id
      GROUP BY l.id ORDER BY l.name COLLATE NOCASE`).all());
  });

  app.post('/api/locations', express.json(), wrap((req, res) => {
    const name = optString(req.body?.name, 'name', 100);
    if (!name) throw new HttpError(400, 'Name is required');
    const notes = optString(req.body?.notes, 'notes') ?? '';
    try {
      const r = db.prepare('INSERT INTO locations (name, notes) VALUES (?, ?)').run(name, notes);
      res.status(201).json(q.location.get(r.lastInsertRowid));
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, `A location named "${name}" already exists`);
      throw e;
    }
  }));

  app.patch('/api/locations/:id', express.json(), wrap((req, res) => {
    const loc = q.location.get(Number(req.params.id));
    if (!loc) throw new HttpError(404, 'No such location');
    const name = optString(req.body?.name, 'name', 100);
    const notes = optString(req.body?.notes, 'notes');
    if (name === '') throw new HttpError(400, 'Name cannot be empty');
    try {
      db.prepare('UPDATE locations SET name = ?, notes = ? WHERE id = ?')
        .run(name ?? loc.name, notes ?? loc.notes, loc.id);
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, `A location named "${name}" already exists`);
      throw e;
    }
    res.json(q.location.get(loc.id));
  }));

  app.delete('/api/locations/:id', wrap((req, res) => {
    const loc = q.location.get(Number(req.params.id));
    if (!loc) throw new HttpError(404, 'No such location');
    const n = db.prepare('SELECT count(*) AS n FROM tapes WHERE location_id = ?').get(loc.id).n;
    if (n > 0) throw new HttpError(409, `"${loc.name}" still holds ${n} tape(s). Move them first.`);
    db.prepare('DELETE FROM locations WHERE id = ?').run(loc.id);
    res.status(204).end();
  }));

  // ------------------------------------------------------------------ tapes

  app.get('/api/tapes', (req, res) => {
    const rows = db.prepare('SELECT * FROM tapes ORDER BY barcode').all();
    res.json(rows.map(tapeView));
  });

  app.post('/api/tapes', express.json(), wrap((req, res) => {
    const b = req.body || {};
    const barcode = cleanBarcode(b.barcode);
    if (q.tapeByBarcode.get(barcode)) throw new HttpError(409, `Tape ${barcode} already exists`);
    const generation = b.generation ?? 'LTO-6';
    if (!(generation in GENERATIONS)) throw new HttpError(400, 'Unknown generation');
    const status = b.status ?? 'active';
    if (!STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
    db.prepare(`INSERT INTO tapes (barcode, name, location_id, generation, capacity_bytes, status, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      barcode, optString(b.name, 'name', 200) ?? '', checkLocation(b.location_id),
      generation, checkCapacity(b.capacity_bytes), status, optString(b.notes, 'notes') ?? '');
    res.status(201).json(tapeView(q.tapeByBarcode.get(barcode)));
  }));

  app.get('/api/tapes/:barcode', wrap((req, res) => {
    const t = mustTape(req.params.barcode);
    const imports = db.prepare(
      'SELECT mode, source, file_count, total_bytes, created_at FROM imports WHERE tape_id = ? ORDER BY id DESC LIMIT 50')
      .all(t.id);
    const hashed = db.prepare('SELECT count(*) AS n FROM files WHERE tape_id = ? AND sha256 IS NOT NULL').get(t.id).n;
    res.json({ ...tapeView(t), hashed_files: hashed, imports });
  }));

  app.patch('/api/tapes/:barcode', express.json(), wrap((req, res) => {
    const t = mustTape(req.params.barcode);
    const b = req.body || {};
    const next = { ...t };
    if (b.barcode !== undefined) {
      next.barcode = cleanBarcode(b.barcode);
      const other = q.tapeByBarcode.get(next.barcode);
      if (other && other.id !== t.id) throw new HttpError(409, `Tape ${next.barcode} already exists`);
    }
    if (b.name !== undefined) next.name = optString(b.name, 'name', 200);
    if (b.notes !== undefined) next.notes = optString(b.notes, 'notes');
    if (b.location_id !== undefined) next.location_id = checkLocation(b.location_id);
    if (b.capacity_bytes !== undefined) next.capacity_bytes = checkCapacity(b.capacity_bytes);
    if (b.generation !== undefined) {
      if (!(b.generation in GENERATIONS)) throw new HttpError(400, 'Unknown generation');
      next.generation = b.generation;
    }
    if (b.status !== undefined) {
      if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Unknown status');
      next.status = b.status;
    }
    db.prepare(`UPDATE tapes SET barcode = ?, name = ?, notes = ?, location_id = ?,
      capacity_bytes = ?, generation = ?, status = ? WHERE id = ?`).run(
      next.barcode, next.name, next.notes, next.location_id,
      next.capacity_bytes, next.generation, next.status, t.id);
    res.json(tapeView(q.tapeByBarcode.get(next.barcode)));
  }));

  app.delete('/api/tapes/:barcode', wrap((req, res) => {
    const t = mustTape(req.params.barcode);
    db.prepare('DELETE FROM tapes WHERE id = ?').run(t.id);
    res.status(204).end();
  }));

  // Browse a tape one directory at a time.
  app.get('/api/tapes/:barcode/tree', wrap((req, res) => {
    const t = mustTape(req.params.barcode);
    const dir = String(req.query.dir || '').replace(/^\/+|\/+$/g, '');
    const limit = 5000;
    const files = db.prepare(
      'SELECT path, size, mtime, sha256 FROM files WHERE tape_id = ? AND dir = ? ORDER BY path LIMIT ?')
      .all(t.id, dir, limit + 1);
    // Every directory below `dir`, rolled up into its immediate children.
    const below = dir === ''
      ? db.prepare(`SELECT dir, count(*) AS n, sum(size) AS bytes FROM files
          WHERE tape_id = ? AND dir != '' GROUP BY dir`).all(t.id)
      : db.prepare(`SELECT dir, count(*) AS n, sum(size) AS bytes FROM files
          WHERE tape_id = ? AND dir >= ? AND dir < ? GROUP BY dir`).all(t.id, dir + '/', dir + '0');
    const children = new Map();
    const skip = dir === '' ? 0 : dir.length + 1;
    for (const r of below) {
      const name = r.dir.slice(skip).split('/')[0];
      const c = children.get(name) || { name, files: 0, bytes: 0 };
      c.files += r.n;
      c.bytes += r.bytes;
      children.set(name, c);
    }
    res.json({
      dir,
      dirs: [...children.values()].sort((a, b) => a.name.localeCompare(b.name)),
      files: files.slice(0, limit).map((f) => ({ ...f, name: f.path.slice(skip) })),
      truncated: files.length > limit,
    });
  }));

  // Full file list for a tape, streamed as JSONL (default) or TSV. The CLI uses
  // this for `verify`; it's also a handy manifest download.
  app.get('/api/tapes/:barcode/files', wrap((req, res) => {
    const t = mustTape(req.params.barcode);
    const tsv = req.query.format === 'tsv';
    res.type(tsv ? 'text/tab-separated-values' : 'application/x-ndjson');
    res.set('Content-Disposition', `inline; filename="${t.barcode}.${tsv ? 'tsv' : 'jsonl'}"`);
    const rows = db.prepare('SELECT path, size, mtime, sha256 FROM files WHERE tape_id = ? ORDER BY path')
      .iterate(t.id);
    let buf = '';
    for (const r of rows) {
      buf += tsv
        ? `${r.path}\t${r.size}\t${r.mtime ?? ''}\t${r.sha256 ?? ''}\n`
        : JSON.stringify(r) + '\n';
      if (buf.length > 1 << 16) {
        res.write(buf);
        buf = '';
      }
    }
    res.end(buf);
  }));

  // Upload a file list for a tape. `mode=replace` (default) makes the list the
  // tape's complete contents; `mode=append` adds or updates entries. A tape that
  // doesn't exist yet is created, so `find | curl` works on a brand-new tape.
  app.post('/api/tapes/:barcode/files',
    express.text({ type: () => true, limit: process.env.MAX_UPLOAD || '512mb' }),
    wrap((req, res) => {
      const mode = req.query.mode || 'replace';
      if (!['replace', 'append'].includes(mode)) throw new HttpError(400, 'mode must be replace or append');
      const text = typeof req.body === 'string' ? req.body : '';
      const { entries, meta, errors } = parseFileList(text);
      if (!entries.length && errors.length) {
        throw new HttpError(400, `Nothing importable. First problems: ${errors.slice(0, 5).join('; ')}`);
      }
      const name = optString(req.query.name ?? meta.name, 'name', 200);
      const source = optString(req.query.source ?? meta.source, 'source', 500) ?? '';

      let t = findTape(req.params.barcode);
      let created = false;
      if (!t) {
        if (req.query.create === '0') throw new HttpError(404, `No tape with barcode ${req.params.barcode}`);
        const barcode = cleanBarcode(req.params.barcode);
        db.prepare('INSERT INTO tapes (barcode, name) VALUES (?, ?)').run(barcode, name ?? '');
        t = q.tapeByBarcode.get(barcode);
        created = true;
      } else if (name && !t.name) {
        db.prepare('UPDATE tapes SET name = ? WHERE id = ?').run(name, t.id);
      }

      const tapeId = t.id;
      db.transaction(() => {
        if (mode === 'replace') {
          // Keep hashes we already know when the new list lacks them and the
          // file is unchanged, so a quick re-index doesn't throw away work.
          const known = new Map();
          for (const r of db.prepare(
            'SELECT path, size, sha256 FROM files WHERE tape_id = ? AND sha256 IS NOT NULL').iterate(tapeId)) {
            known.set(r.path, r);
          }
          for (const e of entries) {
            const k = known.get(e.path);
            if (!e.sha256 && k && k.size === e.size) e.sha256 = k.sha256;
          }
          db.prepare('DELETE FROM files WHERE tape_id = ?').run(tapeId);
          const ins = db.prepare(
            'INSERT INTO files (tape_id, path, dir, size, mtime, sha256) VALUES (?, ?, ?, ?, ?, ?)');
          for (const e of entries) ins.run(tapeId, e.path, e.dir, e.size, e.mtime, e.sha256);
        } else {
          const up = db.prepare(`
            INSERT INTO files (tape_id, path, dir, size, mtime, sha256) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (tape_id, path) DO UPDATE SET
              sha256 = CASE WHEN excluded.size = files.size
                            THEN coalesce(excluded.sha256, files.sha256) ELSE excluded.sha256 END,
              size = excluded.size,
              mtime = excluded.mtime`);
          for (const e of entries) up.run(tapeId, e.path, e.dir, e.size, e.mtime, e.sha256);
        }
        const bytes = entries.reduce((a, e) => a + e.size, 0);
        db.prepare('INSERT INTO imports (tape_id, mode, source, file_count, total_bytes) VALUES (?, ?, ?, ?, ?)')
          .run(tapeId, mode, source, entries.length, bytes);
        db.prepare('UPDATE tapes SET last_indexed_at = ? WHERE id = ?').run(now(), tapeId);
        refreshTapeStats(tapeId);
      })();

      const after = db.prepare('SELECT * FROM tapes WHERE id = ?').get(tapeId);
      res.json({
        tape: tapeView(after), created, mode, imported: entries.length,
        skipped_lines: errors.length, errors,
      });
    }));

  // Record the outcome of `tapewrangler verify`.
  app.post('/api/tapes/:barcode/verify', express.json(), wrap((req, res) => {
    const t = mustTape(req.params.barcode);
    const ok = req.body?.ok === true;
    db.prepare('UPDATE tapes SET last_verified_at = ?, last_verify_ok = ? WHERE id = ?')
      .run(now(), ok ? 1 : 0, t.id);
    res.json(tapeView(q.tapeByBarcode.get(t.barcode)));
  }));

  // ----------------------------------------------------------------- search

  // Space-separated terms, all of which must appear somewhere in the path.
  // Terms of 3+ characters use the trigram index; shorter ones fall back to LIKE.
  // `limit` is per tape unless `tape` narrows the search to one tape.
  app.get('/api/search', wrap((req, res) => {
    const terms = String(req.query.q || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
    if (!terms.length) return res.json({ query: '', total_files: 0, total_bytes: 0, tapes: [] });
    const limit = Math.min(Number(req.query.limit) || 200, 5000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    const where = [];
    const params = [];
    const ftsTerms = terms.filter((x) => x.length >= 3);
    if (ftsTerms.length) {
      where.push('f.id IN (SELECT rowid FROM files_fts WHERE files_fts MATCH ?)');
      params.push(ftsTerms.map((x) => `"${x.replace(/"/g, '""')}"`).join(' AND '));
    }
    for (const x of terms.filter((y) => y.length < 3)) {
      where.push("f.path LIKE ? ESCAPE '\\'");
      params.push(`%${x.replace(/[\\%_]/g, (c) => '\\' + c)}%`);
    }
    if (req.query.tape) {
      where.push('f.tape_id = ?');
      params.push(mustTape(String(req.query.tape)).id);
    }
    const whereSql = where.join(' AND ');

    const summary = db.prepare(`
      SELECT f.tape_id, count(*) AS n, sum(f.size) AS bytes
      FROM files f WHERE ${whereSql} GROUP BY f.tape_id`).all(...params);
    // Within one tape: a plain page of results. Across all tapes: the first
    // `limit` matches from each tape, so one big tape can't crowd out the rest.
    const files = req.query.tape
      ? db.prepare(`
          SELECT f.tape_id, f.path, f.size, f.mtime, f.sha256
          FROM files f WHERE ${whereSql} ORDER BY f.path LIMIT ? OFFSET ?`).all(...params, limit, offset)
      : db.prepare(`
          SELECT tape_id, path, size, mtime, sha256 FROM (
            SELECT f.tape_id, f.path, f.size, f.mtime, f.sha256,
                   row_number() OVER (PARTITION BY f.tape_id ORDER BY f.path) AS rn
            FROM files f WHERE ${whereSql})
          WHERE rn <= ? ORDER BY tape_id, path`).all(...params, limit);

    const byTape = new Map();
    for (const s of summary) {
      const t = db.prepare('SELECT * FROM tapes WHERE id = ?').get(s.tape_id);
      byTape.set(s.tape_id, { ...tapeView(t), match_count: s.n, match_bytes: s.bytes, files: [] });
    }
    for (const f of files) {
      byTape.get(f.tape_id).files.push({ path: f.path, size: f.size, mtime: f.mtime, sha256: f.sha256 });
    }
    const tapes = [...byTape.values()].sort((a, b) => a.barcode.localeCompare(b.barcode));
    res.json({
      query: terms.join(' '),
      total_files: summary.reduce((a, s) => a + s.n, 0),
      total_bytes: summary.reduce((a, s) => a + s.bytes, 0),
      offset, limit, returned: files.length,
      tapes,
    });
  }));

  // ----------------------------------------------------------- single copy

  app.get('/api/single-copy', wrap((req, res) => {
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const byTape = db.prepare(`
      SELECT tape_id, count(*) AS files, sum(size) AS bytes
      FROM (${singleCopySql}) GROUP BY tape_id ORDER BY bytes DESC`).all();
    const tapeInfo = new Map();
    for (const r of byTape) tapeInfo.set(r.tape_id, db.prepare('SELECT * FROM tapes WHERE id = ?').get(r.tape_id));
    let filter = '';
    const params = [];
    if (req.query.tape) {
      filter = 'WHERE tape_id = ?';
      params.push(mustTape(String(req.query.tape)).id);
    }
    const files = db.prepare(`SELECT * FROM (${singleCopySql}) ${filter} ORDER BY path LIMIT ? OFFSET ?`)
      .all(...params, limit, offset);
    for (const f of files) {
      if (!tapeInfo.has(f.tape_id)) tapeInfo.set(f.tape_id, db.prepare('SELECT * FROM tapes WHERE id = ?').get(f.tape_id));
    }
    res.json({
      total_files: byTape.reduce((a, r) => a + r.files, 0),
      total_bytes: byTape.reduce((a, r) => a + r.bytes, 0),
      tapes: byTape.map((r) => ({ ...tapeView(tapeInfo.get(r.tape_id)), single_files: r.files, single_bytes: r.bytes })),
      files: files.map((f) => ({ path: f.path, size: f.size, barcode: tapeInfo.get(f.tape_id).barcode })),
      offset, limit,
    });
  }));

  // ---------------------------------------------------------------- backups

  const BACKUP_NAME_RE = /^tapewrangler-[\w-]+\.db$/;

  app.get('/api/backups', (req, res) => {
    if (!fs.existsSync(backupDir)) return res.json([]);
    const list = fs.readdirSync(backupDir).filter((f) => BACKUP_NAME_RE.test(f)).sort().reverse()
      .map((name) => ({ name, bytes: fs.statSync(path.join(backupDir, name)).size }));
    res.json(list);
  });

  app.get('/api/backups/:name', wrap((req, res) => {
    const name = req.params.name;
    if (!BACKUP_NAME_RE.test(name)) throw new HttpError(400, 'Bad backup name');
    const p = path.join(backupDir, name);
    if (!fs.existsSync(p)) throw new HttpError(404, 'No such backup');
    res.download(p);
  }));

  app.post('/api/backups', wrap(async (req, res) => {
    const dest = await backup(db, backupDir, 'manual');
    pruneBackups(backupDir, 'manual', backupKeep);
    res.status(201).json({ name: path.basename(dest) });
  }));

  // ---------------------------------------------------------------- static

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'Upload too large; raise MAX_UPLOAD' });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Request body is not valid JSON' });
    }
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}

module.exports = { createApp, GENERATIONS };
