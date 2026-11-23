'use strict';

// TapeWrangler web UI: plain JavaScript, no build step.
// Views are chosen by the URL hash: #/ (search), #/tapes, #/tapes/BARCODE,
// #/locations, #/single-copy.

const $ = (sel, root = document) => root.querySelector(sel);
const view = $('#view');
const TOKEN_KEY = 'tapewrangler.token';

// ------------------------------------------------------------------ helpers

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Decimal units, the way tape capacities are quoted (LTO-6 = 2.5 TB).
function bytes(n) {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${i === 0 ? v : v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}
const num = (n) => Number(n || 0).toLocaleString();
const date = (s) => (s ? new Date(s).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const unixDate = (t) => (t ? date(t * 1000) : '—');
function ago(s) {
  if (!s) return 'never';
  const d = (Date.now() - new Date(s).getTime()) / 1000;
  if (d < 90) return 'just now';
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 129600) return `${Math.round(d / 3600)} h ago`;
  if (d < 86400 * 45) return `${Math.round(d / 86400)} days ago`;
  return date(s);
}

function fillBar(t, big = false) {
  const pct = t.fill === null ? 0 : Math.min(100, t.fill * 100);
  return `<div class="fill${big ? ' big' : ''}" title="${pct.toFixed(1)}%"><div style="width:${pct}%"></div></div>`;
}
const statusChip = (s) => `<span class="chip ${esc(s)}">${esc(s)}</span>`;
function verifyChip(t) {
  if (t.last_verify_ok === null) return '<span class="muted small">never</span>';
  return t.last_verify_ok
    ? `<span class="chip ok" title="${esc(t.last_verified_at)}">passed ${esc(ago(t.last_verified_at))}</span>`
    : `<span class="chip bad" title="${esc(t.last_verified_at)}">problems ${esc(ago(t.last_verified_at))}</span>`;
}
const barcodeLink = (b) => `<a class="barcode" href="#/tapes/${encodeURIComponent(b)}">${esc(b)}</a>`;

// Wrap every occurrence of any search term in <mark>, escaping the rest.
function highlight(text, terms) {
  if (!terms.length) return esc(text);
  const re = new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi');
  let out = '';
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (!m[0]) continue;
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>';
    last = m.index + m[0].length;
  }
  return out + esc(text.slice(last));
}

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function hashParams() {
  const h = location.hash.replace(/^#\/?/, '');
  const [p, qs] = h.split('?');
  return { path: decodeURIComponent(p || ''), params: new URLSearchParams(qs || '') };
}
function link(path, params = {}) {
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined));
  const s = qs.toString();
  return `#/${path}${s ? '?' + s : ''}`;
}

// ---------------------------------------------------------------------- API

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(t) {
  try { localStorage.setItem(TOKEN_KEY, t); } catch { /* private mode */ }
}

async function api(method, url, body, retried = false) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const r = await fetch(url, init);
  if (r.status === 401 && !retried) {
    if (await askToken()) return api(method, url, body, true);
  }
  if (r.status === 204) return null;
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `${r.status} ${r.statusText}`);
  return data;
}

// A small separate dialog so it can appear on top of another open dialog.
function askToken() {
  return new Promise((resolve) => {
    const d = document.createElement('dialog');
    d.innerHTML = `<form method="dialog">
      <h2>API token needed</h2>
      <p class="muted small">This server only allows changes with its token (the
      <code>TAPEWRANGLER_TOKEN</code> it was started with). It's saved in this browser.</p>
      <label class="field"><span>Token</span><input type="password" name="token" required autocomplete="off"></label>
      <div class="dialog-actions"><button class="btn" value="cancel" formnovalidate>Cancel</button>
      <button class="btn primary" value="ok">Save</button></div></form>`;
    document.body.append(d);
    d.addEventListener('close', () => {
      const ok = d.returnValue === 'ok';
      if (ok) setToken(d.querySelector('input').value.trim());
      d.remove();
      refreshFooter();
      resolve(ok);
    });
    d.showModal();
  });
}

// ------------------------------------------------------------------- dialog

// Shows the shared form dialog. `onOk(formData)` may throw to keep it open.
function openDialog({ title, body, okLabel = 'Save', danger = false, onOk }) {
  const d = $('#dialog');
  $('#dialog-title').textContent = title;
  $('#dialog-body').innerHTML = body;
  const err = $('#dialog-error');
  err.hidden = true;
  const ok = $('#dialog-ok');
  ok.textContent = okLabel;
  ok.className = `btn ${danger ? 'danger' : 'primary'}`;
  const form = $('#dialog-form');
  form.onsubmit = async (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    ok.disabled = true;
    try {
      await onOk(new FormData(form));
      d.close();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      ok.disabled = false;
    }
  };
  d.showModal();
  const first = d.querySelector('#dialog-body input, #dialog-body select, #dialog-body textarea');
  if (first) first.focus();
}

// ------------------------------------------------------------ shared state

let generations = [];
let locationsCache = [];

async function loadLocations() {
  locationsCache = await api('GET', '/api/locations');
  return locationsCache;
}

function locationOptions(selected) {
  return '<option value="">— none —</option>' + locationsCache.map((l) =>
    `<option value="${l.id}"${l.id === selected ? ' selected' : ''}>${esc(l.name)}</option>`).join('');
}

async function refreshStats() {
  try {
    const s = await api('GET', '/api/stats');
    $('#stats').innerHTML = `
      <a class="stat" href="#/tapes"><div class="label">Tapes</div><div class="value">${num(s.tapes)}</div></a>
      <div class="stat"><div class="label">Files</div><div class="value">${num(s.files)}</div></div>
      <div class="stat"><div class="label">Stored</div><div class="value">${bytes(s.bytes)}</div></div>
      <a class="stat" href="#/locations"><div class="label">Locations</div><div class="value">${num(s.locations)}</div></a>
      <a class="stat${s.single_copy_files ? ' warn' : ''}" href="#/single-copy" title="Files that exist on only one tape">
        <div class="label">Only one copy</div><div class="value">${bytes(s.single_copy_bytes)}</div></a>`;
  } catch (e) {
    $('#stats').innerHTML = `<div class="stat"><div class="label">Server</div><div class="value error small">${esc(e.message)}</div></div>`;
  }
}

async function refreshFooter() {
  try {
    const [v, a] = await Promise.all([api('GET', '/api/version'), api('GET', '/api/auth')]);
    let auth = '';
    if (a.required) {
      auth = a.valid ? ' · token saved' : ' · <a href="#" id="set-token">read-only, set token</a>';
    }
    $('#version').innerHTML = `TapeWrangler ${esc(v.version)} · ${esc(String(v.commit).slice(0, 7))} · schema v${esc(v.schema)}${auth}`;
    const st = $('#set-token');
    if (st) st.onclick = (e) => { e.preventDefault(); askToken(); };
  } catch { /* footer is best-effort */ }
}

// ------------------------------------------------------------------ search

function curlHint() {
  const origin = location.origin;
  return `<pre class="hint"># with the CLI (reads the barcode from the mounted tape)
tapewrangler index /mnt/tape

# or with nothing but find and curl
find /mnt/tape -type f -printf '%P\\t%s\\t%T@\\n' | \\
  curl --data-binary @- "${esc(origin)}/api/tapes/ABC123L6/files?name=Photos%201"</pre>`;
}

async function renderSearch(params) {
  const qStr = params.get('q') || '';
  const tape = params.get('tape') || '';
  const offset = Number(params.get('offset')) || 0;
  $('#search-input').value = qStr;

  if (!qStr.trim()) {
    const tapes = await api('GET', '/api/tapes');
    if (!tapes.length) {
      view.innerHTML = `<div class="card"><div class="empty">
        <img src="logo.png" alt="" class="mascot">
        <h2>Nothing cataloged yet</h2>
        <p>Add a <a href="#/locations">location</a> and a <a href="#/tapes">tape</a>, then send it a file list.</p>
        ${curlHint()}</div></div>`;
      return;
    }
    const recent = [...tapes].sort((a, b) => String(b.last_indexed_at).localeCompare(String(a.last_indexed_at))).slice(0, 8);
    view.innerHTML = `
      <div class="view-head"><div><h1>Search</h1>
        <div class="sub">Type part of any file or folder name. Every word must match; results are grouped by tape.</div></div></div>
      <div class="card"><div class="card-head"><h2 class="grow">Recently indexed</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Tape</th><th>Name</th><th class="hide-sm">Location</th>
        <th class="num">Files</th><th>Indexed</th></tr></thead><tbody>
        ${recent.map((t) => `<tr class="link" data-href="#/tapes/${encodeURIComponent(t.barcode)}">
          <td>${barcodeLink(t.barcode)}</td><td>${esc(t.name)}</td><td class="hide-sm">${esc(t.location || '—')}</td>
          <td class="num">${num(t.file_count)}</td><td class="nowrap">${esc(ago(t.last_indexed_at))}</td></tr>`).join('')}
      </tbody></table></div></div>`;
    return;
  }

  const limit = tape ? 500 : 25;
  const r = await api('GET', `/api/search?${new URLSearchParams({ q: qStr, tape, limit, offset })}`);
  const terms = r.query.split(/\s+/).filter(Boolean);
  if (!r.total_files) {
    view.innerHTML = `<div class="card"><div class="empty"><h2>No matches</h2>
      <p>Nothing on any tape matches <b>${esc(qStr)}</b>${tape ? ` on ${esc(tape)}` : ''}.</p></div></div>`;
    return;
  }

  const head = tape
    ? `<div class="view-head"><div><h1>${num(r.total_files)} matches on ${barcodeLink(tape)}</h1>
        <div class="sub">${bytes(r.total_bytes)} · <a href="${link('', { q: qStr })}">all tapes</a></div></div></div>`
    : `<div class="view-head"><div><h1>${num(r.total_files)} matching files</h1>
        <div class="sub">${bytes(r.total_bytes)} on ${r.tapes.length} tape${r.tapes.length === 1 ? '' : 's'}:
        ${r.tapes.map((t) => esc(t.barcode)).join(', ')}</div></div></div>`;

  const cards = r.tapes.map((t) => {
    const shown = t.files.length;
    let more = '';
    if (tape) {
      const next = offset + limit < t.match_count;
      const prev = offset > 0;
      more = (next || prev) ? `<div class="more btn-row">
        ${prev ? `<a class="btn small" href="${link('', { q: qStr, tape, offset: Math.max(0, offset - limit) })}">← Previous</a>` : ''}
        <span class="muted small" style="align-self:center">${num(offset + 1)}–${num(offset + shown)} of ${num(t.match_count)}</span>
        ${next ? `<a class="btn small" href="${link('', { q: qStr, tape, offset: offset + limit })}">Next →</a>` : ''}</div>` : '';
    } else if (shown < t.match_count) {
      more = `<div class="more small"><span class="muted">Showing ${shown} of ${num(t.match_count)}.</span>
        <a href="${link('', { q: qStr, tape: t.barcode })}">Show all on ${esc(t.barcode)} →</a></div>`;
    }
    return `<div class="card">
      <div class="card-head">${barcodeLink(t.barcode)}
        <div class="grow"><b>${esc(t.name || 'Untitled')}</b>
          <span class="muted small"> · ${esc(t.location || 'no location')}</span></div>
        ${statusChip(t.status)}
        <span class="muted small">${num(t.match_count)} match${t.match_count === 1 ? '' : 'es'} · ${bytes(t.match_bytes)}</span>
      </div>
      <div class="table-wrap"><table><tbody>
        ${t.files.map((f) => `<tr><td class="path">${highlight(f.path, terms)}</td>
          <td class="num">${bytes(f.size)}</td><td class="num hide-sm muted">${unixDate(f.mtime)}</td></tr>`).join('')}
      </tbody></table></div>${more}</div>`;
  }).join('');
  view.innerHTML = head + cards;
}

// ------------------------------------------------------------------- tapes

function tapeFormBody(t = {}) {
  const cap = t.capacity_is_custom ? t.capacity_bytes / 1e12 : '';
  return `
    <div class="row2">
      <label class="field"><span>Barcode</span>
        <input type="text" name="barcode" required maxlength="32" value="${esc(t.barcode || '')}"
          placeholder="ABC123L6" style="text-transform:uppercase" class="mono"></label>
      <label class="field"><span>Generation</span><select name="generation">
        ${generations.map((g) => `<option${g.name === (t.generation || 'LTO-6') ? ' selected' : ''}>${esc(g.name)}</option>`).join('')}
      </select></label>
    </div>
    <label class="field"><span>Name</span>
      <input type="text" name="name" maxlength="200" value="${esc(t.name || '')}" placeholder="Photos 2025"></label>
    <div class="row2">
      <label class="field"><span>Location</span><select name="location_id">${locationOptions(t.location_id)}</select></label>
      <label class="field"><span>Status</span><select name="status">
        ${['active', 'full', 'offsite', 'retired'].map((s) => `<option${s === (t.status || 'active') ? ' selected' : ''}>${s}</option>`).join('')}
      </select></label>
    </div>
    <label class="field"><span>Capacity override in TB (blank = native for the generation)</span>
      <input type="number" name="capacity_tb" min="0" step="any" value="${esc(cap)}"></label>
    <label class="field"><span>Notes</span><textarea name="notes" maxlength="500">${esc(t.notes || '')}</textarea></label>`;
}

function tapeFormData(fd) {
  const tb = fd.get('capacity_tb');
  return {
    barcode: fd.get('barcode'),
    name: fd.get('name'),
    generation: fd.get('generation'),
    location_id: fd.get('location_id') ? Number(fd.get('location_id')) : null,
    status: fd.get('status'),
    capacity_bytes: tb ? Number(tb) * 1e12 : null,
    notes: fd.get('notes'),
  };
}

async function addTape(presetLocation) {
  await loadLocations();
  openDialog({
    title: 'Add tape',
    body: tapeFormBody({ location_id: presetLocation }),
    okLabel: 'Add tape',
    onOk: async (fd) => {
      const t = await api('POST', '/api/tapes', tapeFormData(fd));
      toast(`Added ${t.barcode}`);
      location.hash = `#/tapes/${encodeURIComponent(t.barcode)}`;
      refreshStats();
    },
  });
}

async function renderTapes(params) {
  const [tapes] = await Promise.all([api('GET', '/api/tapes'), loadLocations()]);
  const loc = params.get('loc') || '';
  const status = params.get('status') || '';
  const shown = tapes.filter((t) =>
    (!loc || (loc === 'none' ? t.location_id === null : String(t.location_id) === loc)) &&
    (!status || t.status === status));

  view.innerHTML = `
    <div class="view-head">
      <div><h1>Tapes</h1><div class="sub">${num(shown.length)} of ${num(tapes.length)} shown</div></div>
      <div class="btn-row">
        <select class="inline" id="f-loc" aria-label="Filter by location">
          <option value="">All locations</option><option value="none"${loc === 'none' ? ' selected' : ''}>No location</option>
          ${locationsCache.map((l) => `<option value="${l.id}"${String(l.id) === loc ? ' selected' : ''}>${esc(l.name)}</option>`).join('')}
        </select>
        <select class="inline" id="f-status" aria-label="Filter by status">
          <option value="">Any status</option>
          ${['active', 'full', 'offsite', 'retired'].map((s) => `<option${s === status ? ' selected' : ''}>${s}</option>`).join('')}
        </select>
        <button class="btn primary" id="add-tape">+ Add tape</button>
      </div>
    </div>
    ${shown.length ? `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Barcode</th><th>Name</th><th class="hide-sm">Location</th><th>Status</th>
        <th class="num">Files</th><th>Used</th><th class="hide-sm">Indexed</th><th class="hide-sm">Verified</th></tr></thead>
      <tbody>${shown.map((t) => `<tr class="link" data-href="#/tapes/${encodeURIComponent(t.barcode)}">
        <td>${barcodeLink(t.barcode)}</td>
        <td>${esc(t.name || '')}</td>
        <td class="hide-sm">${esc(t.location || '—')}</td>
        <td>${statusChip(t.status)}</td>
        <td class="num">${num(t.file_count)}</td>
        <td class="fill-cell">${fillBar(t)}<div class="small muted">${bytes(t.used_bytes)} of ${bytes(t.capacity_bytes)}</div></td>
        <td class="hide-sm nowrap">${esc(ago(t.last_indexed_at))}</td>
        <td class="hide-sm">${verifyChip(t)}</td></tr>`).join('')}
      </tbody></table></div></div>`
    : `<div class="card"><div class="empty"><h2>${tapes.length ? 'No tapes match the filter' : 'No tapes yet'}</h2>
        <p>Add one here, or just index a tape and it will be created automatically.</p>${curlHint()}</div></div>`}`;

  const refilter = () => {
    location.hash = link('tapes', { loc: $('#f-loc').value, status: $('#f-status').value });
  };
  $('#f-loc').onchange = refilter;
  $('#f-status').onchange = refilter;
  $('#add-tape').onclick = () => addTape(loc && loc !== 'none' ? Number(loc) : null);
}

async function renderTape(barcode, params) {
  const dir = params.get('dir') || '';
  const [t, tree] = await Promise.all([
    api('GET', `/api/tapes/${encodeURIComponent(barcode)}`),
    api('GET', `/api/tapes/${encodeURIComponent(barcode)}/tree?${new URLSearchParams({ dir })}`),
  ]);
  if (t.barcode !== barcode) { // opened via the 6-character volume serial
    location.replace(`#/tapes/${encodeURIComponent(t.barcode)}`);
    return;
  }

  const segs = dir ? dir.split('/') : [];
  const tapeLink = (d) => link(`tapes/${encodeURIComponent(t.barcode)}`, { dir: d });
  const crumbs = [`<a href="${tapeLink('')}">${esc(t.barcode)}</a>`].concat(segs.map((s, i) =>
    `<a href="${tapeLink(segs.slice(0, i + 1).join('/'))}">${esc(s)}</a>`)).join('<span class="sep">/</span>');

  const browser = t.file_count === 0
    ? `<div class="empty"><h2>No files cataloged</h2>
        <p>Mount the tape and index it:</p>${curlHint().replace('ABC123L6', esc(t.barcode))}</div>`
    : `<div class="table-wrap"><table>
        <thead><tr><th>Name</th><th class="num">Size</th><th class="num hide-sm">Modified</th></tr></thead><tbody>
        ${dir ? `<tr class="link" data-href="${tapeLink(segs.slice(0, -1).join('/'))}"><td class="path">..</td><td></td><td class="hide-sm"></td></tr>` : ''}
        ${tree.dirs.map((d) => `<tr class="link" data-href="${tapeLink(dir ? `${dir}/${d.name}` : d.name)}">
          <td class="path"><span class="dir-icon">▸</span>${esc(d.name)}/</td>
          <td class="num">${bytes(d.bytes)}</td><td class="num hide-sm muted">${num(d.files)} files</td></tr>`).join('')}
        ${tree.files.map((f) => `<tr><td class="path" title="${esc(f.sha256 ? 'sha256 ' + f.sha256 : '')}">${esc(f.name)}</td>
          <td class="num">${bytes(f.size)}</td><td class="num hide-sm muted">${unixDate(f.mtime)}</td></tr>`).join('')}
        </tbody></table></div>
        ${tree.truncated ? '<div class="more small muted">Only the first 5,000 files in this folder are shown. Use search to find the rest.</div>' : ''}`;

  view.innerHTML = `
    <div class="view-head">
      <div class="tape-title">
        <span class="barcode">${esc(t.barcode)}</span>
        <h1>${esc(t.name || 'Untitled')}</h1>
        <div class="sub">${statusChip(t.status)} ${esc(t.generation)} · ${esc(t.location || 'no location')}</div>
      </div>
      <div class="btn-row">
        <button class="btn" id="edit-tape">Edit</button>
        <button class="btn danger" id="delete-tape">Delete</button>
      </div>
    </div>
    <div class="grid2">
      <div class="card">
        <div class="card-head"><div class="crumbs grow">${crumbs}</div>
          <a class="small" href="${link('', { tape: t.barcode, q: '' })}" id="search-tape">Search this tape</a></div>
        ${browser}
      </div>
      <div>
        <div class="card"><div class="card-body">
          ${fillBar(t, true)}
          <p class="small" style="margin:6px 0 14px">${bytes(t.used_bytes)} of ${bytes(t.capacity_bytes)}
            ${t.fill !== null ? `(${(t.fill * 100).toFixed(1)}%)` : ''}${t.capacity_is_custom ? ' · custom capacity' : ''}</p>
          <dl class="kv">
            <dt>Files</dt><dd>${num(t.file_count)}</dd>
            <dt>Hashed</dt><dd>${num(t.hashed_files)} ${t.file_count ? `<span class="muted small">(${Math.round(100 * t.hashed_files / t.file_count)}%)</span>` : ''}</dd>
            <dt>Location</dt><dd>${esc(t.location || '—')}</dd>
            <dt>Added</dt><dd>${date(t.created_at)}</dd>
            <dt>Indexed</dt><dd>${esc(ago(t.last_indexed_at))}</dd>
            <dt>Verified</dt><dd>${verifyChip(t)}</dd>
            ${t.notes ? `<dt>Notes</dt><dd>${esc(t.notes)}</dd>` : ''}
          </dl>
          <p class="small" style="margin:14px 0 0">File list:
            <a href="/api/tapes/${encodeURIComponent(t.barcode)}/files" download>JSONL</a> ·
            <a href="/api/tapes/${encodeURIComponent(t.barcode)}/files?format=tsv" download>TSV</a></p>
        </div></div>
        <div class="card"><div class="card-head"><h2 class="grow">History</h2></div>
          ${t.imports.length ? `<div class="table-wrap"><table><tbody>
            ${t.imports.map((i) => `<tr><td><div>${esc(i.mode === 'replace' ? 'Indexed' : 'Added')} ${num(i.file_count)} files</div>
              <div class="small muted">${esc(i.source || '')}</div></td>
              <td class="num small muted">${bytes(i.total_bytes)}<br>${esc(ago(i.created_at))}</td></tr>`).join('')}
          </tbody></table></div>` : '<div class="card-body muted small">No imports yet.</div>'}
        </div>
      </div>
    </div>`;

  $('#search-tape').onclick = (e) => {
    e.preventDefault();
    const input = $('#search-input');
    input.focus();
    input.dataset.tape = t.barcode;
    input.placeholder = `Search ${t.barcode}…`;
  };
  $('#edit-tape').onclick = async () => {
    await loadLocations();
    openDialog({
      title: `Edit ${t.barcode}`,
      body: tapeFormBody(t),
      onOk: async (fd) => {
        const u = await api('PATCH', `/api/tapes/${encodeURIComponent(t.barcode)}`, tapeFormData(fd));
        toast('Saved');
        if (u.barcode !== t.barcode) location.hash = `#/tapes/${encodeURIComponent(u.barcode)}`;
        else render();
        refreshStats();
      },
    });
  };
  $('#delete-tape').onclick = () => openDialog({
    title: `Delete ${t.barcode}?`,
    body: `<p>This removes the tape and its ${num(t.file_count)} file entries from the catalog.
      Nothing on the tape itself is touched, and you can re-index it later.</p>`,
    okLabel: 'Delete',
    danger: true,
    onOk: async () => {
      await api('DELETE', `/api/tapes/${encodeURIComponent(t.barcode)}`);
      toast(`Deleted ${t.barcode}`);
      location.hash = '#/tapes';
      refreshStats();
    },
  });
}

// --------------------------------------------------------------- locations

function locationBody(l = {}) {
  return `<label class="field"><span>Name</span>
      <input type="text" name="name" required maxlength="100" value="${esc(l.name || '')}" placeholder="Closet shelf"></label>
    <label class="field"><span>Notes</span><textarea name="notes" maxlength="500">${esc(l.notes || '')}</textarea></label>`;
}

async function renderLocations() {
  const [locs, tapes] = await Promise.all([loadLocations(), api('GET', '/api/tapes')]);
  const unassigned = tapes.filter((t) => t.location_id === null);
  view.innerHTML = `
    <div class="view-head">
      <div><h1>Locations</h1><div class="sub">Where the cartridges physically are. A location can be removed once it's empty.</div></div>
      <button class="btn primary" id="add-loc">+ Add location</button>
    </div>
    ${locs.length || unassigned.length ? `<div class="card"><div class="table-wrap"><table>
      <thead><tr><th>Name</th><th class="num">Tapes</th><th class="num">Stored</th><th class="hide-sm">Notes</th><th></th></tr></thead>
      <tbody>
      ${locs.map((l) => `<tr>
        <td><a href="${link('tapes', { loc: l.id })}"><b>${esc(l.name)}</b></a></td>
        <td class="num">${num(l.tape_count)}</td>
        <td class="num">${bytes(l.used_bytes)}</td>
        <td class="hide-sm muted small">${esc(l.notes)}</td>
        <td class="num"><div class="btn-row" style="justify-content:flex-end">
          <button class="btn small" data-edit="${l.id}">Rename</button>
          <button class="btn icon" data-del="${l.id}" ${l.tape_count ? `disabled title="Move its ${l.tape_count} tape(s) elsewhere first"` : 'title="Remove location"'} aria-label="Remove ${esc(l.name)}">−</button>
        </div></td></tr>`).join('')}
      ${unassigned.length ? `<tr><td><a href="${link('tapes', { loc: 'none' })}" class="muted"><i>No location</i></a></td>
        <td class="num">${num(unassigned.length)}</td>
        <td class="num">${bytes(unassigned.reduce((a, t) => a + t.used_bytes, 0))}</td><td class="hide-sm"></td><td></td></tr>` : ''}
      </tbody></table></div></div>`
    : '<div class="card"><div class="empty"><h2>No locations yet</h2><p>Add places like "Closet shelf", "Fire safe" or "Mom\'s house".</p></div></div>'}`;

  $('#add-loc').onclick = () => openDialog({
    title: 'Add location',
    body: locationBody(),
    okLabel: 'Add',
    onOk: async (fd) => {
      await api('POST', '/api/locations', { name: fd.get('name'), notes: fd.get('notes') });
      toast('Location added');
      render();
      refreshStats();
    },
  });
  view.querySelectorAll('[data-edit]').forEach((b) => {
    b.onclick = () => {
      const l = locs.find((x) => x.id === Number(b.dataset.edit));
      openDialog({
        title: 'Edit location',
        body: locationBody(l),
        onOk: async (fd) => {
          await api('PATCH', `/api/locations/${l.id}`, { name: fd.get('name'), notes: fd.get('notes') });
          toast('Saved');
          render();
        },
      });
    };
  });
  view.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = async () => {
      const l = locs.find((x) => x.id === Number(b.dataset.del));
      try {
        await api('DELETE', `/api/locations/${l.id}`);
        toast(`Removed ${l.name}`);
        render();
        refreshStats();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
}

// ------------------------------------------------------------- single copy

async function renderSingleCopy(params) {
  const tape = params.get('tape') || '';
  const offset = Number(params.get('offset')) || 0;
  const limit = 500;
  const r = await api('GET', `/api/single-copy?${new URLSearchParams({ tape, offset, limit })}`);
  if (!r.total_files) {
    view.innerHTML = `<div class="view-head"><div><h1>Single copy</h1></div></div>
      <div class="card"><div class="empty"><h2>Everything has a second copy</h2>
      <p>Every cataloged file exists on at least two tapes that aren't retired.</p></div></div>`;
    return;
  }
  const shownTotal = tape ? (r.tapes.find((t) => t.barcode === tape)?.single_files || 0) : r.total_files;
  view.innerHTML = `
    <div class="view-head"><div><h1>Single copy</h1>
      <div class="sub">${num(r.total_files)} files (${bytes(r.total_bytes)}) exist on only one tape. A file counts as a
      copy when the same path and size are on another tape that isn't retired.</div></div></div>
    <div class="card"><div class="card-head"><h2 class="grow">By tape</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Tape</th><th>Name</th><th class="hide-sm">Location</th>
        <th class="num">Files only here</th><th class="num">Size</th></tr></thead><tbody>
      ${r.tapes.map((t) => `<tr class="link" data-href="${link('single-copy', { tape: t.barcode })}"${t.barcode === tape ? ' style="background:var(--accent-soft)"' : ''}>
        <td>${barcodeLink(t.barcode)}</td><td>${esc(t.name)}</td><td class="hide-sm">${esc(t.location || '—')}</td>
        <td class="num">${num(t.single_files)}</td><td class="num">${bytes(t.single_bytes)}</td></tr>`).join('')}
      </tbody></table></div></div>
    <div class="card"><div class="card-head"><h2 class="grow">Files${tape ? ` only on ${esc(tape)}` : ''}</h2>
      ${tape ? `<a class="small" href="#/single-copy">Show all tapes</a>` : ''}</div>
      <div class="table-wrap"><table><tbody>
      ${r.files.map((f) => `<tr><td class="path">${esc(f.path)}</td><td class="num">${bytes(f.size)}</td>
        <td class="num">${tape ? '' : barcodeLink(f.barcode)}</td></tr>`).join('')}
      </tbody></table></div>
      ${shownTotal > limit ? `<div class="more btn-row">
        ${offset > 0 ? `<a class="btn small" href="${link('single-copy', { tape, offset: Math.max(0, offset - limit) })}">← Previous</a>` : ''}
        <span class="muted small" style="align-self:center">${num(offset + 1)}–${num(offset + r.files.length)} of ${num(shownTotal)}</span>
        ${offset + limit < shownTotal ? `<a class="btn small" href="${link('single-copy', { tape, offset: offset + limit })}">Next →</a>` : ''}
      </div>` : ''}
    </div>`;
}

// ------------------------------------------------------------------ router

let renderSeq = 0;
async function render() {
  const seq = ++renderSeq;
  const { path, params } = hashParams();
  const [section, ...rest] = path.split('/');
  const tab = section === 'search' || section === '' ? 'search' : section;
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === tab));
  const input = $('#search-input');
  if (tab !== 'search') input.value = '';
  if (tab !== 'tapes' || !rest.length) {
    delete input.dataset.tape;
    input.placeholder = 'Search file and folder names across all tapes…';
  }
  if (params.get('tape') && tab === 'search') input.dataset.tape = params.get('tape');
  try {
    if (tab === 'search') await renderSearch(params);
    else if (tab === 'tapes' && rest.length) await renderTape(rest.join('/'), params);
    else if (tab === 'tapes') await renderTapes(params);
    else if (tab === 'locations') await renderLocations();
    else if (tab === 'single-copy') await renderSingleCopy(params);
    else view.innerHTML = '<div class="card"><div class="empty"><h2>Not found</h2></div></div>';
  } catch (e) {
    if (seq === renderSeq) view.innerHTML = `<div class="card"><div class="empty"><h2>Something went wrong</h2><p class="error">${esc(e.message)}</p></div></div>`;
  }
}

// Clickable table rows.
view.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (row && !e.target.closest('a, button')) location.hash = row.dataset.href;
});

// Live search as you type (debounced), without filling the back-button history.
let searchTimer;
function runSearch(immediate) {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    const input = $('#search-input');
    const target = link('', { q: input.value.trim(), tape: input.dataset.tape || '' });
    if (location.hash !== target) {
      const onSearch = hashParams().path === '' || hashParams().path === 'search';
      if (onSearch && !immediate) {
        history.replaceState(null, '', target);
        render();
      } else {
        location.hash = target;
      }
    }
  }, immediate ? 0 : 250);
}
$('#search-input').addEventListener('input', () => runSearch(false));
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); runSearch(true); });
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.target.closest('input, textarea, select')) {
    e.preventDefault();
    $('#search-input').focus();
  }
});

window.addEventListener('hashchange', render);

(async function init() {
  try { generations = await api('GET', '/api/generations'); } catch { generations = [{ name: 'LTO-6' }]; }
  refreshStats();
  refreshFooter();
  render();
})();
