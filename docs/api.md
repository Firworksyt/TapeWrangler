# TapeWrangler API

The contract between the server, the web UI and the CLI. All paths are under
`/api`, and everything is JSON unless noted.

## Auth

Reads (`GET`) are open. Anything that changes the catalog needs
`Authorization: Bearer <TAPEWRANGLER_TOKEN>` when the server has a token set,
and gets `401` otherwise.

`GET /api/auth` → `{ "required": true, "valid": false }` for the token sent, if any.

## Barcodes

Barcodes are stored uppercase and matched case-insensitively. LTFS reports a
6-character volume serial (`ABC123`) while cartridge labels usually carry the
media suffix too (`ABC123L6`). Any `:barcode` in a path accepts either: a
6-character serial resolves to the one 8-character barcode that starts with it.

## File lists

`POST /api/tapes/:barcode/files` takes a file list as the request body, in
either of two formats (detected per line):

**TSV**: `path<TAB>size[<TAB>mtime[<TAB>sha256]]`. Exactly what this prints:

```sh
find /mnt/tape -type f -printf '%P\t%s\t%T@\n'
```

**JSONL**: one object per line. An optional first line carries tape details.

```json
{"_meta": {"name": "Photos 2025", "source": "cli write /home/me/photos"}}
{"path": "photos/2025/beach.jpg", "size": 3000000, "mtime": 1735689600, "sha256": "9f86d0…"}
```

Paths are relative to the tape root with `/` separators; a leading `./` or `/`
is stripped and `\` is converted. Anything under `.tapewrangler/` (the CLI's
on-tape manifests) is ignored.

Query parameters:

| param    | meaning |
|----------|---------|
| `mode`   | `replace` (default): the list becomes the tape's complete contents. `append`: add or update entries. |
| `name`   | tape name, used if the tape is new or has no name yet |
| `source` | free text shown in the tape's history |
| `create` | `0` to return 404 for an unknown barcode instead of creating the tape |

On `replace`, hashes already known for a path are kept when the new list has
no hash and the size is unchanged, so a quick re-index doesn't lose them.

Response: `{ tape, created, mode, imported, skipped_lines, errors }`.

`GET /api/tapes/:barcode/files` returns the whole list as JSONL (default) or
TSV (`?format=tsv`), sorted by path.

## Locations

| method & path | body / notes |
|---|---|
| `GET /api/locations` | each with `tape_count`, `used_bytes` |
| `POST /api/locations` | `{ name, notes? }` → 201, 409 if the name exists |
| `PATCH /api/locations/:id` | `{ name?, notes? }` |
| `DELETE /api/locations/:id` | 204, or 409 while it still holds tapes |

## Tapes

| method & path | body / notes |
|---|---|
| `GET /api/tapes` | all tapes |
| `POST /api/tapes` | `{ barcode, name?, location_id?, generation?, capacity_bytes?, status?, notes? }` |
| `GET /api/tapes/:barcode` | tape plus `hashed_files` and recent `imports` |
| `PATCH /api/tapes/:barcode` | any of the POST fields; `location_id: null` clears it |
| `DELETE /api/tapes/:barcode` | removes the tape and its file entries (not the data on tape!) |
| `GET /api/tapes/:barcode/tree?dir=a/b` | one folder: `{ dirs: [{name, files, bytes}], files: [...] }` |
| `POST /api/tapes/:barcode/verify` | `{ ok: true }`: records the result of a verify |

`generation` is one of `LTO-5` … `LTO-10`, `LTO-M8` or `Other`
(`GET /api/generations` lists them with native capacities). `status` is
`active`, `full`, `offsite` or `retired`. `capacity_bytes: null` means "the
generation's native capacity".

A tape as returned by the API:

```json
{
  "barcode": "ABC123L6", "name": "Photos 2025", "location_id": 1, "location": "Closet shelf",
  "generation": "LTO-6", "capacity_bytes": 2500000000000, "capacity_is_custom": false,
  "status": "active", "notes": "", "file_count": 18233, "used_bytes": 2310000000000, "fill": 0.924,
  "created_at": "2026-09-26T03:00:00Z", "last_indexed_at": "…", "last_verified_at": null, "last_verify_ok": null
}
```

## Search

`GET /api/search?q=beach 2025` matches files whose path contains every word
(case-insensitive). Words of 3+ characters use a trigram index.

- Without `tape`: up to `limit` (default 200) matches **per tape**.
- With `tape=BARCODE`: one tape, paged with `limit` and `offset`.

Response: `{ query, total_files, total_bytes, tapes: [ { ...tape, match_count, match_bytes, files: [...] } ] }`.

## Single copy

`GET /api/single-copy?tape=&limit=&offset=` lists files whose path and size
appear on only one tape that isn't retired: `{ total_files, total_bytes, tapes: [...], files: [...] }`.

## Other

| | |
|---|---|
| `GET /api/stats` | totals for the header |
| `GET /api/version` | `{ version, commit, built, schema }` |
| `GET /api/backups` | list of database backups |
| `GET /api/backups/:name` | download one |
| `POST /api/backups` | take a backup now |
