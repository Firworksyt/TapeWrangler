'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDatabase } = require('../src/db');
const { createApp } = require('../src/app');
const { parseFileList } = require('../src/importer');

async function start(opts = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tw-test-'));
  const { db, backupDir } = await openDatabase({ dataDir, log: () => {} });
  const app = createApp({ db, backupDir, token: opts.token || '', version: { version: 'test' } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, headers = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) {
      if (typeof body === 'string') {
        init.body = body;
      } else {
        init.body = JSON.stringify(body);
        init.headers['content-type'] = 'application/json';
      }
    }
    const r = await fetch(base + url, init);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: r.status, json, text };
  };
  const stop = () => new Promise((resolve) => server.close(() => { db.close(); resolve(); }));
  return { call, stop, db, dataDir };
}

test('parses TSV from find -printf and JSONL', () => {
  const tsv = 'photos/a.jpg\t100\t1700000000.123\nphotos/b.jpg\t200\n./x\t5\n.tapewrangler/m.jsonl\t9\nbad line\n';
  const r = parseFileList(tsv);
  assert.equal(r.entries.length, 3);
  assert.deepEqual(r.entries[0], { path: 'photos/a.jpg', dir: 'photos', size: 100, mtime: 1700000000, sha256: null });
  assert.equal(r.entries[2].path, 'x');
  assert.equal(r.errors.length, 1);

  const jsonl = '{"_meta":{"name":"Photos 1"}}\n{"path":"a\\\\b.txt","size":3,"sha256":"' + 'A'.repeat(64) + '"}\n';
  const j = parseFileList(jsonl);
  assert.equal(j.meta.name, 'Photos 1');
  assert.equal(j.entries[0].path, 'a/b.txt');
  assert.equal(j.entries[0].sha256, 'a'.repeat(64));
});

test('locations: add, list, refuse to delete while holding tapes', async () => {
  const { call, stop } = await start();
  try {
    const shelf = await call('POST', '/api/locations', { name: 'Closet shelf' });
    assert.equal(shelf.status, 201);
    assert.equal((await call('POST', '/api/locations', { name: 'closet SHELF' })).status, 409);

    const tape = await call('POST', '/api/tapes',
      { barcode: 'abc123l6', name: 'Photos 1', location_id: shelf.json.id });
    assert.equal(tape.status, 201);
    assert.equal(tape.json.barcode, 'ABC123L6');
    assert.equal(tape.json.capacity_bytes, 2.5e12);

    const del = await call('DELETE', `/api/locations/${shelf.json.id}`);
    assert.equal(del.status, 409);

    await call('PATCH', '/api/tapes/ABC123L6', { location_id: null });
    assert.equal((await call('DELETE', `/api/locations/${shelf.json.id}`)).status, 204);
  } finally {
    await stop();
  }
});

test('import, browse, search, and single-copy report', async () => {
  const { call, stop } = await start();
  try {
    // Uploading to an unknown barcode creates the tape.
    const up = await call('POST', '/api/tapes/AAA001L6/files?name=Photos%20A&source=test',
      'photos/2025/beach.jpg\t1000\t1700000000\nphotos/2025/dog.jpg\t2000\ndocs/taxes.pdf\t300\n');
    assert.equal(up.status, 200, up.text);
    assert.equal(up.json.created, true);
    assert.equal(up.json.tape.file_count, 3);
    assert.equal(up.json.tape.used_bytes, 3300);

    await call('POST', '/api/tapes/BBB002L6/files', 'photos/2025/beach.jpg\t1000\n');

    const root = await call('GET', '/api/tapes/AAA001L6/tree');
    assert.deepEqual(root.json.dirs.map((d) => [d.name, d.files, d.bytes]),
      [['docs', 1, 300], ['photos', 2, 3000]]);
    const sub = await call('GET', '/api/tapes/AAA001L6/tree?dir=photos/2025');
    assert.deepEqual(sub.json.files.map((f) => f.name), ['beach.jpg', 'dog.jpg']);

    const s = await call('GET', '/api/search?q=BEACH');
    assert.equal(s.json.total_files, 2);
    assert.deepEqual(s.json.tapes.map((t) => t.barcode), ['AAA001L6', 'BBB002L6']);
    const s2 = await call('GET', '/api/search?q=photos%20do');
    assert.equal(s2.json.total_files, 1);
    assert.equal(s2.json.tapes[0].files[0].path, 'photos/2025/dog.jpg');

    const single = await call('GET', '/api/single-copy');
    assert.equal(single.json.total_files, 2); // dog.jpg and taxes.pdf
    assert.equal(single.json.tapes[0].barcode, 'AAA001L6');

    // A retired tape no longer counts as a copy.
    await call('PATCH', '/api/tapes/BBB002L6', { status: 'retired' });
    assert.equal((await call('GET', '/api/single-copy')).json.total_files, 3);

    // The 6-character LTFS volume serial resolves to the full barcode.
    assert.equal((await call('GET', '/api/tapes/AAA001')).json.barcode, 'AAA001L6');
  } finally {
    await stop();
  }
});

test('replace keeps known hashes; append upserts', async () => {
  const { call, stop } = await start();
  try {
    const h = 'b'.repeat(64);
    await call('POST', '/api/tapes/CCC003L6/files', `a.bin\t10\t1\t${h}\nb.bin\t20\t1\t${h}\n`);
    // Quick re-index without hashes: a.bin unchanged keeps its hash; b.bin changed size loses it.
    await call('POST', '/api/tapes/CCC003L6/files', 'a.bin\t10\nb.bin\t21\n');
    let list = (await call('GET', '/api/tapes/CCC003L6/files')).text.trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(list[0].sha256, h);
    assert.equal(list[1].sha256, null);

    await call('POST', '/api/tapes/CCC003L6/files?mode=append', '{"path":"c.bin","size":5}\n');
    list = (await call('GET', '/api/tapes/CCC003L6/files')).text.trim().split('\n');
    assert.equal(list.length, 3);
    const detail = await call('GET', '/api/tapes/CCC003L6');
    assert.equal(detail.json.imports.length, 3);
    assert.equal(detail.json.used_bytes, 36);
  } finally {
    await stop();
  }
});

test('token is required for changes but not reads', async () => {
  const { call, stop } = await start({ token: 'sekrit' });
  try {
    assert.equal((await call('GET', '/api/tapes')).status, 200);
    assert.equal((await call('POST', '/api/locations', { name: 'X' })).status, 401);
    assert.equal((await call('POST', '/api/locations', { name: 'X' }, { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await call('POST', '/api/locations', { name: 'X' }, { authorization: 'Bearer sekrit' })).status, 201);
  } finally {
    await stop();
  }
});

test('refuses to open a database newer than this build', async () => {
  const { db, dataDir, stop } = await start();
  await stop();
  // Pretend the database is one version behind, then reopen.
  const Database = require('better-sqlite3');
  const raw = new Database(path.join(dataDir, 'tapewrangler.db'));
  const v = raw.pragma('user_version', { simple: true });
  raw.close();
  assert.ok(v >= 1);
  assert.ok(db);
  const tooNew = new Database(path.join(dataDir, 'tapewrangler.db'));
  tooNew.pragma(`user_version = ${v + 100}`);
  tooNew.close();
  await assert.rejects(openDatabase({ dataDir, log: () => {} }), /only knows up to/);
});
