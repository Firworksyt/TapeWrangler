package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestParseAllowsOptionsAfterPositionals(t *testing.T) {
	fl := newFlags("index", "<mountpoint>", "")
	hash := fl.Bool("hash", false, "")
	bc := fl.String("barcode", "", "")
	pos, err := fl.parse([]string{"/mnt/tape", "--hash", "--barcode", "ABC123L6"}, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(pos) != 1 || pos[0] != "/mnt/tape" || !*hash || *bc != "ABC123L6" {
		t.Fatalf("got pos=%v hash=%v barcode=%q", pos, *hash, *bc)
	}
}

func TestManifestRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	in := []FileEntry{{Path: "a/b.txt", Size: 3, Mtime: 5, SHA256: "ab"}, {Path: "c", Size: 0}}
	if err := writeManifest(&buf, ManifestMeta{Barcode: "X1", Name: "n"}, in); err != nil {
		t.Fatal(err)
	}
	meta, out, err := readManifest(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if meta.Barcode != "X1" || meta.Name != "n" || len(out) != 2 || out[0] != in[0] || out[1] != in[1] {
		t.Fatalf("round trip mismatch: %+v %+v", meta, out)
	}
}

func TestWalkSkipsBookkeeping(t *testing.T) {
	dir := t.TempDir()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.MkdirAll(filepath.Join(dir, "photos", "2025"), 0o755))
	must(os.MkdirAll(filepath.Join(dir, tapeMetaDir), 0o755))
	must(os.WriteFile(filepath.Join(dir, "photos", "2025", "a.jpg"), []byte("hello"), 0o644))
	must(os.WriteFile(filepath.Join(dir, tapeMetaDir, "m.jsonl"), []byte("{}"), 0o644))
	entries, err := walkTape(dir)
	must(err)
	if len(entries) != 1 || entries[0].Path != "photos/2025/a.jpg" || entries[0].Size != 5 {
		t.Fatalf("unexpected walk result: %+v", entries)
	}
}

func TestJoinSlash(t *testing.T) {
	if got := joinSlash("", "photos", "/2025/", "a.jpg"); got != "photos/2025/a.jpg" {
		t.Fatal(got)
	}
}
