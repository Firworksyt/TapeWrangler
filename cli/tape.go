package main

// Working with a mounted LTFS tape: identifying it, listing its files, and
// reading them in an order that's kind to the drive.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Big reads and writes keep the drive streaming instead of stopping and
// repositioning ("shoe-shining"). LTFS's default block size is 512 KiB.
const ioBufferSize = 4 << 20

// Top-level folders that operating systems like to drop onto any volume.
var skipTopLevel = map[string]bool{
	tapeMetaDir: true, "$RECYCLE.BIN": true, "System Volume Information": true,
	".Trashes": true, ".Spotlight-V100": true, ".fseventsd": true, ".TemporaryItems": true,
}

// tapeIdentity works out the barcode and volume name for a mount point,
// preferring what the user passed on the command line.
func tapeIdentity(mount, flagBarcode, flagName string) (barcode, name string, err error) {
	barcode, name = flagBarcode, flagName
	if barcode == "" {
		if v, ok := getxattr(mount, "ltfs.volumeSerial"); ok {
			barcode = v
		}
	}
	if name == "" {
		if v, ok := getxattr(mount, "ltfs.volumeName"); ok {
			name = v
		}
	}
	if barcode == "" {
		return "", "", fmt.Errorf("couldn't read the barcode from %s (is it an LTFS mount?); pass --barcode", mount)
	}
	return strings.ToUpper(strings.TrimSpace(barcode)), name, nil
}

func checkMount(mount string) error {
	st, err := os.Stat(mount)
	if err != nil {
		return err
	}
	if !st.IsDir() {
		return fmt.Errorf("%s is not a directory", mount)
	}
	return nil
}

// walkTape lists every regular file under mount, with paths relative to it.
func walkTape(mount string) ([]FileEntry, error) {
	var out []FileEntry
	err := filepath.WalkDir(mount, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(mount, p)
		if rel == "." {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if d.IsDir() {
			if !strings.Contains(rel, "/") && skipTopLevel[rel] {
				return fs.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil // symlinks, devices, etc.
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		out = append(out, FileEntry{Path: rel, Size: info.Size(), Mtime: info.ModTime().Unix()})
		return nil
	})
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, err
}

// sortForReading orders files by where they start on tape, using the LTFS
// "ltfs.startblock" attribute. Reading in path order can make the drive seek
// back and forth for hours; this makes it one pass from start to end.
func sortForReading(mount string, entries []FileEntry) []FileEntry {
	type keyed struct {
		e     FileEntry
		block int64
	}
	ks := make([]keyed, len(entries))
	found := 0
	for i, e := range entries {
		ks[i] = keyed{e, 1 << 62}
		if v, ok := getxattr(filepath.Join(mount, filepath.FromSlash(e.Path)), "ltfs.startblock"); ok {
			if n, err := strconv.ParseInt(v, 10, 64); err == nil {
				ks[i].block = n
				found++
			}
		}
	}
	sort.SliceStable(ks, func(i, j int) bool { return ks[i].block < ks[j].block })
	out := make([]FileEntry, len(ks))
	for i, k := range ks {
		out[i] = k.e
	}
	if found == 0 && len(entries) > 0 {
		fmt.Fprintln(os.Stderr, "note: tape positions unavailable, reading in path order")
	}
	return out
}

// hashFile returns the SHA-256 of a file, reporting bytes read to p.
func hashFile(path string, p *progress) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	buf := make([]byte, ioBufferSize)
	if _, err := io.CopyBuffer(h, &countingReader{f, p}, buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

type countingReader struct {
	r io.Reader
	p *progress
}

func (c *countingReader) Read(b []byte) (int, error) {
	n, err := c.r.Read(b)
	c.p.addBytes(int64(n))
	return n, err
}

// ---------------------------------------------------------------- progress

type progress struct {
	label      string
	totalFiles int64
	totalBytes int64
	files      int64
	bytes      int64
	start      time.Time
	last       time.Time
	tty        bool
}

func newProgress(label string, files, bytes int64) *progress {
	st, _ := os.Stderr.Stat()
	now := time.Now()
	return &progress{
		label: label, totalFiles: files, totalBytes: bytes, start: now, last: now,
		tty: st != nil && st.Mode()&os.ModeCharDevice != 0,
	}
}

func (p *progress) addBytes(n int64) {
	p.bytes += n
	p.maybePrint()
}

func (p *progress) fileDone() {
	p.files++
	p.maybePrint()
}

func (p *progress) maybePrint() {
	now := time.Now()
	interval := 500 * time.Millisecond
	if !p.tty {
		interval = 60 * time.Second // occasional lines for logs and cron
	}
	if now.Sub(p.last) < interval {
		return
	}
	p.last = now
	p.print(false)
}

func (p *progress) print(final bool) {
	elapsed := time.Since(p.start).Seconds()
	rate := 0.0
	if elapsed > 0 {
		rate = float64(p.bytes) / elapsed
	}
	line := fmt.Sprintf("%s: %d/%d files, %s/%s, %s/s", p.label, p.files, p.totalFiles,
		humanBytes(p.bytes), humanBytes(p.totalBytes), humanBytes(int64(rate)))
	if !final && rate > 0 && p.totalBytes > p.bytes {
		eta := time.Duration(float64(p.totalBytes-p.bytes)/rate) * time.Second
		line += ", " + eta.Round(time.Minute).String() + " left"
	}
	if p.tty {
		fmt.Fprintf(os.Stderr, "\r\033[K%s", line)
		if final {
			fmt.Fprintln(os.Stderr)
		}
	} else {
		fmt.Fprintln(os.Stderr, line)
	}
}

func (p *progress) finish() {
	p.print(true)
}

// humanBytes uses decimal units, like tape capacities (LTO-6 = 2.5 TB).
func humanBytes(n int64) string {
	units := []string{"B", "KB", "MB", "GB", "TB", "PB"}
	v := float64(n)
	i := 0
	for v >= 1000 && i < len(units)-1 {
		v /= 1000
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d B", n)
	}
	return fmt.Sprintf("%.2f %s", v, units[i])
}
