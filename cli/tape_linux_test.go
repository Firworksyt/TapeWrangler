//go:build linux

package main

import (
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// Simulates LTFS attributes on a normal directory (needs a filesystem with
// user xattrs, which most Linux ones have).
func TestLTFSAttributes(t *testing.T) {
	dir := t.TempDir()
	if err := syscall.Setxattr(dir, "user.ltfs.volumeSerial", []byte("abc123"), 0); err != nil {
		t.Skip("filesystem has no user xattrs:", err)
	}
	bc, _, err := tapeIdentity(dir, "", "")
	if err != nil || bc != "ABC123" {
		t.Fatalf("barcode %q, err %v", bc, err)
	}

	blocks := map[string]string{"a": "300", "b": "100", "c": "200"}
	var entries []FileEntry
	for name, block := range blocks {
		p := filepath.Join(dir, name)
		if err := os.WriteFile(p, []byte(name), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := syscall.Setxattr(p, "user.ltfs.startblock", []byte(block), 0); err != nil {
			t.Fatal(err)
		}
		entries = append(entries, FileEntry{Path: name, Size: 1})
	}
	got := sortForReading(dir, entries)
	if got[0].Path != "b" || got[1].Path != "c" || got[2].Path != "a" {
		t.Fatalf("not in tape order: %v", got)
	}
}
