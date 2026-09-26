package main

// Manifests: JSONL file lists, one file per line, optionally preceded by a
// {"_meta": {...}} line. The same format is uploaded to the server, kept
// locally as a safety copy, and written onto the tape under .tapewrangler/.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Directory on the tape where the CLI keeps its manifests. Never cataloged.
const tapeMetaDir = ".tapewrangler"

type FileEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	Mtime  int64  `json:"mtime,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

type ManifestMeta struct {
	Barcode string `json:"barcode,omitempty"`
	Name    string `json:"name,omitempty"`
	Source  string `json:"source,omitempty"`
	Created string `json:"created,omitempty"`
	Tool    string `json:"tool,omitempty"`
}

func writeManifest(w io.Writer, meta ManifestMeta, entries []FileEntry) error {
	bw := bufio.NewWriter(w)
	enc := json.NewEncoder(bw)
	if meta.Created == "" {
		meta.Created = time.Now().UTC().Format(time.RFC3339)
	}
	meta.Tool = "tapewrangler-cli/" + version
	if err := enc.Encode(map[string]ManifestMeta{"_meta": meta}); err != nil {
		return err
	}
	for _, e := range entries {
		if err := enc.Encode(e); err != nil {
			return err
		}
	}
	return bw.Flush()
}

func writeManifestFile(path string, meta ManifestMeta, entries []FileEntry) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	if err := writeManifest(f, meta, entries); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

func readManifest(r io.Reader) (ManifestMeta, []FileEntry, error) {
	var meta ManifestMeta
	var entries []FileEntry
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 1<<20), 16<<20)
	line := 0
	for sc.Scan() {
		line++
		b := sc.Bytes()
		if len(strings.TrimSpace(string(b))) == 0 {
			continue
		}
		var probe struct {
			Meta *ManifestMeta `json:"_meta"`
			FileEntry
		}
		if err := json.Unmarshal(b, &probe); err != nil {
			return meta, nil, fmt.Errorf("line %d: %w", line, err)
		}
		if probe.Meta != nil {
			meta = *probe.Meta
			continue
		}
		entries = append(entries, probe.FileEntry)
	}
	return meta, entries, sc.Err()
}

func readManifestFile(path string) (ManifestMeta, []FileEntry, error) {
	f, err := os.Open(path)
	if err != nil {
		return ManifestMeta{}, nil, err
	}
	defer f.Close()
	return readManifest(f)
}

// localManifestPath is where a safety copy of each manifest is kept, so a
// failed upload can be retried with `tapewrangler push`.
func localManifestPath(barcode, kind string) (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	ts := time.Now().Format("20060102-150405")
	return filepath.Join(dir, "manifests", fmt.Sprintf("%s-%s-%s.jsonl", barcode, kind, ts)), nil
}

// hashesOnTape reads every manifest the CLI previously wrote to the tape and
// returns the known hashes by path, so re-indexing can keep them without
// re-reading the files. Later manifests win.
func hashesOnTape(mount string) map[string]FileEntry {
	known := map[string]FileEntry{}
	matches, _ := filepath.Glob(filepath.Join(mount, tapeMetaDir, "*.jsonl"))
	for _, m := range matches { // Glob returns sorted names; they start with a timestamp
		_, entries, err := readManifestFile(m)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.SHA256 != "" {
				known[e.Path] = e
			}
		}
	}
	return known
}
