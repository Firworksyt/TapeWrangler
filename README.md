<p align="center"><img src="docs/tapir.png" alt="TapeWrangler's mascot, a purple and white tapir, nudging a stack of LTO tapes" width="480"></p>

# TapeWrangler

A self-hosted catalog of what's on your LTO tapes. It records which files are
on which tape and which tape is on which shelf, and gives you one search box
across all of them.

The intent is to help organize and search through archived data.
This is NOT a comprehensive backup system: the server never touches a tape drive. The CLI can but it's roughly equivalent to a cp or rsync with some additional metadata handling.

Write tapes however you like (`cp`, `rsync`, `tar`, the included CLI), then
send the file list to the server.

- **Search** file and folder names across every tape, grouped by tape.
- **Tapes**: barcode, name, location, status, fill level, browsable file tree, history.
- **Locations**: where the cartridges physically live.
- **Single copy**: files that exist on only one tape, so you know what still needs a second copy.
- **CLI** (`tapewrangler`) to write, index and verify LTFS tapes, and keep the catalog in sync.
- **REST API**, so `find | curl` works with no CLI at all.

```
TapeWrangler/
├── server/       Node.js + SQLite server and web UI (published as a Docker image)
├── cli/          the tapewrangler command, in Go
├── docs/api.md   the API both sides use
└── docker-compose.yml
```

## Running the server

The image is published to GHCR on every commit to `master` that touches
`server/`. Watchtower picks it up.

```sh
mkdir tapewrangler && cd tapewrangler
curl -fsSLO https://raw.githubusercontent.com/Firworksyt/TapeWrangler/master/docker-compose.yml
curl -fsSL  https://raw.githubusercontent.com/Firworksyt/TapeWrangler/master/.env.example -o .env
echo "TAPEWRANGLER_TOKEN=$(openssl rand -hex 24)" >> .env   # or edit .env by hand
mkdir -p data && sudo chown 1000:1000 data                   # container runs as uid 1000
docker compose up -d
```

Then open `http://<vm>:3000`. The compose file includes a watchtower service;
delete it if the VM already runs one.

### Settings (environment variables)

| variable | default | |
|---|---|---|
| `TAPEWRANGLER_TOKEN` | *(required in compose)* | needed for any change: CLI uploads, edits in the UI |
| `PORT` | `3000` | host port (compose) |
| `BACKUP_INTERVAL_HOURS` | `24` | `0` turns automatic backups off |
| `BACKUP_KEEP` | `14` | automatic backups to keep |
| `MAX_UPLOAD` | `512mb` | largest file list accepted in one upload |

### Data and upgrades

Everything lives in `./data`: `tapewrangler.db` and `backups/`.

Watchtower deploys new images unattended, so schema changes are handled
carefully:

- Each schema change is a numbered migration in `server/src/migrations/`. On
  startup the server applies any pending ones inside a transaction.
- **Before migrating, it writes a backup** to `data/backups/`.
- If the database is *newer* than the image (e.g. after rolling back), the
  server refuses to start rather than guess.
- A backup is also taken every `BACKUP_INTERVAL_HOURS`.

To restore: stop the container, copy a backup over `data/tapewrangler.db`,
delete any `tapewrangler.db-wal`/`-shm` files next to it, and start it again.

The CLI also writes a manifest onto each tape it writes (in `.tapewrangler/`),
so the catalog can be rebuilt from the tapes themselves if it's ever lost.

## The CLI

One static binary for Linux, macOS and Windows, with no dependencies.

### Install

Download it from [Releases](https://github.com/Firworksyt/TapeWrangler/releases):

```sh
sudo curl -fsSL -o /usr/local/bin/tapewrangler \
  https://github.com/Firworksyt/TapeWrangler/releases/latest/download/tapewrangler-linux-amd64
sudo chmod +x /usr/local/bin/tapewrangler
tapewrangler login https://tapes.example.lan     # asks for the token, saves it
```

Or build from source with Go 1.24+: `cd cli && go build -o tapewrangler .`

Settings come from `--server`/`--token`, then `TAPEWRANGLER_SERVER`/`TAPEWRANGLER_TOKEN`,
then the config file that `login` writes (`~/.config/tapewrangler/config.toml` on Linux).

### Commands

```sh
# Copy onto the tape, hashing as it goes, then record it. Like `cp -r`:
# this creates /mnt/tape/photos. Re-running resumes an interrupted write.
tapewrangler write ~/photos /mnt/tape
tapewrangler write ~/photos ~/docs /mnt/tape --into 2026-backup

# Catalog a tape that's already written (by anything). Replaces the tape's
# file list on the server. --hash also reads every file to record SHA-256s.
tapewrangler index /mnt/tape
tapewrangler index /mnt/tape --hash

# Re-read the tape and compare against the catalog. Exits 1 on problems.
tapewrangler verify /mnt/tape
tapewrangler verify /mnt/tape --quick     # sizes only, no reading

tapewrangler search beach 2025
tapewrangler tapes
tapewrangler push <manifest.jsonl>        # retry an upload that failed
```

A few things the CLI does for you:

- **Reads the barcode from the tape.** On Linux and macOS, LTFS exposes the
  volume serial as an extended attribute. On Windows, or if that fails, pass
  `--barcode`.
- **Never loses a file list.** It's saved locally before uploading. If the
  server is down, the error tells you the `push` command to send it later.
- **Reads in tape order.** `verify` and `index --hash` sort files by their
  position on tape (the LTFS `startblock` attribute), so the drive streams
  from start to end instead of seeking back and forth.
- **Keeps hashes.** `index` reuses hashes from the manifests `write` left on
  the tape, and the server keeps known hashes when a re-index doesn't include
  them.

After `write`, unmount the tape (or eject it) so LTFS writes its index to the
cartridge.

### Barcodes

LTFS reports a 6-character volume serial (`ABC123`), while the label on the
cartridge is usually 8 (`ABC123L6`). If you add the tape in the web UI with
its full label first, the CLI's 6-character serial finds it. Otherwise the
tape gets cataloged under the 6-character serial. You can rename it in the UI.

## Without the CLI

Any machine with `find` and `curl` can catalog a tape:

```sh
find /mnt/tape -type f -printf '%P\t%s\t%T@\n' | \
  curl --data-binary @- -H "Authorization: Bearer $TOKEN" \
  "https://tapes.example.lan/api/tapes/ABC123L6/files?name=Photos%202025"
```

The tape is created if it doesn't exist. Add `&mode=append` to add to a tape's
list instead of replacing it. See [docs/api.md](docs/api.md) for the rest.

## Development

```sh
cd server && npm install && npm run dev   # http://localhost:3000, data in server/data
npm test && npm run lint

cd cli && go test ./... && go build -o tapewrangler .
./tapewrangler index /some/dir --barcode TEST01L6 --server http://localhost:3000
```

Any directory works as a stand-in for a tape; just pass `--barcode`.

Releases: pushing to `master` publishes the server image (when `server/`
changed). Pushing a tag like `cli-v0.2.0` publishes CLI binaries.

## License

[WTFPL](LICENSE)
