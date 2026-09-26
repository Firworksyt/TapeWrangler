'use strict';

// Parsing of uploaded file lists.
//
// Two formats are accepted, detected per line:
//
//   JSONL  {"path":"photos/a.jpg","size":123,"mtime":1700000000,"sha256":"..."}
//          An optional first line {"_meta":{"name":"...","source":"..."}} carries
//          tape details. This is what the CLI sends and writes to manifests.
//
//   TSV    path<TAB>size[<TAB>mtime[<TAB>sha256]]
//          Exactly what this prints, so it can be piped straight in:
//          find /mnt/tape -type f -printf '%P\t%s\t%T@\n'

// Files the CLI keeps on the tape for its own bookkeeping; never cataloged.
const INTERNAL_PREFIX = '.tapewrangler/';

function normalizePath(p) {
  let s = String(p).replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  s = s.replace(/^\/+/, '').replace(/\/{2,}/g, '/');
  return s;
}

function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function toInt(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? n : NaN;
}

// Returns { entries, meta, errors }. `errors` holds up to 20 bad lines.
function parseFileList(text) {
  const entries = [];
  const errors = [];
  let meta = {};
  let lineNo = 0;
  const seen = new Map(); // path -> index, so later duplicates win

  for (const raw of text.split('\n')) {
    lineNo++;
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) continue;

    let path, size, mtime, sha256;
    if (line.trimStart().startsWith('{')) {
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        if (errors.length < 20) errors.push(`line ${lineNo}: invalid JSON`);
        continue;
      }
      if (obj._meta) {
        meta = { ...meta, ...obj._meta };
        continue;
      }
      ({ path, size, mtime, sha256 } = obj);
    } else {
      [path, size, mtime, sha256] = line.split('\t');
    }

    if (typeof path !== 'string' || !path.length) {
      if (errors.length < 20) errors.push(`line ${lineNo}: missing path`);
      continue;
    }
    path = normalizePath(path);
    if (!path || path.startsWith(INTERNAL_PREFIX)) continue;

    const sizeN = toInt(size);
    const mtimeN = toInt(mtime);
    if (sizeN === null || Number.isNaN(sizeN) || sizeN < 0) {
      if (errors.length < 20) errors.push(`line ${lineNo}: missing or invalid size`);
      continue;
    }
    const hash = typeof sha256 === 'string' && /^[0-9a-f]{64}$/i.test(sha256.trim())
      ? sha256.trim().toLowerCase() : null;

    const entry = {
      path,
      dir: dirOf(path),
      size: sizeN,
      mtime: Number.isNaN(mtimeN) ? null : mtimeN,
      sha256: hash,
    };
    if (seen.has(path)) {
      entries[seen.get(path)] = entry;
    } else {
      seen.set(path, entries.length);
      entries.push(entry);
    }
  }
  return { entries, meta, errors };
}

module.exports = { parseFileList, normalizePath, dirOf, INTERNAL_PREFIX };
