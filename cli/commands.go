package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"text/tabwriter"
	"time"
)

// upload writes a local safety copy of the manifest, sends it, and removes the
// copy once the server has it. If the server can't be reached the copy stays,
// and the error says how to send it later.
func upload(c *Client, meta ManifestMeta, entries []FileEntry, mode string) (*UploadResult, error) {
	local, err := localManifestPath(meta.Barcode, mode)
	if err != nil {
		return nil, err
	}
	if err := writeManifestFile(local, meta, entries); err != nil {
		return nil, fmt.Errorf("saving local manifest: %w", err)
	}
	var buf bytes.Buffer
	if err := writeManifest(&buf, meta, entries); err != nil {
		return nil, err
	}
	res, err := c.Upload(meta.Barcode, mode, meta.Name, meta.Source, &buf)
	if err != nil {
		return nil, fmt.Errorf("upload failed: %w\nThe file list is saved; send it later with:\n  tapewrangler push %s", err, local)
	}
	os.Remove(local)
	return res, nil
}

func printUploaded(res *UploadResult, verb string) {
	t := res.Tape
	created := ""
	if res.Created {
		created = " (new tape added to the catalog)"
	}
	fmt.Printf("%s %d files on %s%s\n", verb, res.Imported, t.Barcode, created)
	if t.CapacityBytes != nil && *t.CapacityBytes > 0 {
		fmt.Printf("Tape now holds %d files, %s of %s (%.1f%%)\n", t.FileCount,
			humanBytes(t.UsedBytes), humanBytes(int64(*t.CapacityBytes)), 100*float64(t.UsedBytes)/(*t.CapacityBytes))
	}
	if res.SkippedLines > 0 {
		fmt.Fprintf(os.Stderr, "warning: the server skipped %d lines: %s\n", res.SkippedLines, strings.Join(res.Errors, "; "))
	}
}

// ------------------------------------------------------------------- index

func cmdIndex(args []string) error {
	fl := newFlags("index", "<mountpoint>",
		"Catalog everything on a mounted tape, replacing what the server had for it.")
	barcode := fl.String("barcode", "", "tape barcode (default: read from LTFS)")
	name := fl.String("name", "", "tape name (default: the LTFS volume name)")
	hash := fl.Bool("hash", false, "also read every file and record its SHA-256 (reads the whole tape)")
	out := fl.String("out", "", "also save the file list to this path")
	dry := fl.Bool("dry-run", false, "list what would be sent without contacting the server")
	cfg := fl.serverFlags()
	pos, err := fl.parse(args, 1, 1)
	if err != nil {
		return err
	}
	mount := pos[0]
	if err := checkMount(mount); err != nil {
		return err
	}
	bc, nm, err := tapeIdentity(mount, *barcode, *name)
	if err != nil {
		return err
	}

	fmt.Fprintf(os.Stderr, "Reading the file list of %s...\n", bc)
	entries, err := walkTape(mount)
	if err != nil {
		return err
	}
	var total int64
	for _, e := range entries {
		total += e.Size
	}
	fmt.Fprintf(os.Stderr, "%d files, %s\n", len(entries), humanBytes(total))

	// Hashes the CLI already recorded on the tape when writing it.
	known := hashesOnTape(mount)
	reused := 0
	for i, e := range entries {
		if k, ok := known[e.Path]; ok && k.Size == e.Size {
			entries[i].SHA256 = k.SHA256
			reused++
		}
	}
	if reused > 0 {
		fmt.Fprintf(os.Stderr, "Reused %d hashes from manifests on the tape\n", reused)
	}

	if *hash {
		var todo []int
		var todoBytes int64
		for i, e := range entries {
			if e.SHA256 == "" {
				todo = append(todo, i)
				todoBytes += e.Size
			}
		}
		if len(todo) > 0 {
			idx := map[string]int{}
			sub := make([]FileEntry, len(todo))
			for j, i := range todo {
				sub[j] = entries[i]
				idx[entries[i].Path] = i
			}
			p := newProgress("Hashing", int64(len(sub)), todoBytes)
			for _, e := range sortForReading(mount, sub) {
				h, err := hashFile(filepath.Join(mount, filepath.FromSlash(e.Path)), p)
				if err != nil {
					p.finish()
					return fmt.Errorf("reading %s: %w", e.Path, err)
				}
				entries[idx[e.Path]].SHA256 = h
				p.fileDone()
			}
			p.finish()
		}
	}

	meta := ManifestMeta{Barcode: bc, Name: nm, Source: "cli index " + absPath(mount)}
	if *out != "" {
		if err := writeManifestFile(*out, meta, entries); err != nil {
			return err
		}
		fmt.Fprintf(os.Stderr, "Saved file list to %s\n", *out)
	}
	if *dry {
		if *out == "" {
			return writeManifest(os.Stdout, meta, entries)
		}
		return nil
	}
	c, err := cfg.client()
	if err != nil {
		return err
	}
	res, err := upload(c, meta, entries, "replace")
	if err != nil {
		return err
	}
	printUploaded(res, "Indexed")
	return nil
}

// ------------------------------------------------------------------- write

type copyItem struct {
	src   string
	dest  string // relative to the mount, '/' separated
	size  int64
	mtime time.Time
}

func cmdWrite(args []string) error {
	fl := newFlags("write", "<source>... <mountpoint>",
		"Copy files or folders onto a mounted tape, hashing them on the way, and add them to the catalog.\n"+
			"Like `cp -r`, each source keeps its own name: `write ~/photos /mnt/tape` creates /mnt/tape/photos.")
	barcode := fl.String("barcode", "", "tape barcode (default: read from LTFS)")
	name := fl.String("name", "", "tape name, if the tape is new to the catalog")
	into := fl.String("into", "", "folder on the tape to copy into (default: the top level)")
	overwrite := fl.Bool("overwrite", false, "replace files on the tape that differ from the source")
	force := fl.Bool("force", false, "start even if the tape reports too little free space")
	dry := fl.Bool("dry-run", false, "show what would be copied and stop")
	cfg := fl.serverFlags()
	pos, err := fl.parse(args, 2, -1)
	if err != nil {
		return err
	}
	mount := pos[len(pos)-1]
	sources := pos[:len(pos)-1]
	if err := checkMount(mount); err != nil {
		return err
	}
	bc, nm, err := tapeIdentity(mount, *barcode, *name)
	if err != nil {
		return err
	}
	var c *Client
	if !*dry {
		// Fail now, not after hours of copying, if the server config is missing.
		if c, err = cfg.client(); err != nil {
			return err
		}
	}

	// Plan.
	prefix := strings.Trim(filepath.ToSlash(*into), "/")
	var items []copyItem
	for _, src := range sources {
		src = filepath.Clean(src)
		st, err := os.Stat(src)
		if err != nil {
			return err
		}
		base := filepath.Base(absPath(src))
		if !st.IsDir() {
			items = append(items, copyItem{src, joinSlash(prefix, base), st.Size(), st.ModTime()})
			continue
		}
		err = filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.Type().IsRegular() {
				if !d.IsDir() {
					fmt.Fprintf(os.Stderr, "skipping %s (not a regular file)\n", p)
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, _ := filepath.Rel(src, p)
			items = append(items, copyItem{p, joinSlash(prefix, base, filepath.ToSlash(rel)), info.Size(), info.ModTime()})
			return nil
		})
		if err != nil {
			return err
		}
	}
	sort.Slice(items, func(i, j int) bool { return items[i].dest < items[j].dest })

	// Skip what's already on the tape (lets an interrupted write resume).
	var todo []copyItem
	var already []FileEntry
	var todoBytes int64
	known := hashesOnTape(mount)
	for _, it := range items {
		if strings.HasPrefix(it.dest, tapeMetaDir+"/") {
			return fmt.Errorf("refusing to write into %s/, which TapeWrangler uses for its own files", tapeMetaDir)
		}
		dst := filepath.Join(mount, filepath.FromSlash(it.dest))
		if st, err := os.Stat(dst); err == nil {
			if st.Size() == it.size && st.ModTime().Unix() == it.mtime.Unix() {
				e := FileEntry{Path: it.dest, Size: it.size, Mtime: it.mtime.Unix()}
				if k, ok := known[it.dest]; ok && k.Size == it.size {
					e.SHA256 = k.SHA256
				}
				already = append(already, e)
				continue
			}
			if !*overwrite {
				return fmt.Errorf("%s already exists on the tape and differs from %s (use --overwrite to replace it)", it.dest, it.src)
			}
		}
		todo = append(todo, it)
		todoBytes += it.size
	}

	fmt.Fprintf(os.Stderr, "%s: %d files to copy (%s)", bc, len(todo), humanBytes(todoBytes))
	if len(already) > 0 {
		fmt.Fprintf(os.Stderr, ", %d already on the tape", len(already))
	}
	fmt.Fprintln(os.Stderr)
	if free, ok := freeSpace(mount); ok {
		fmt.Fprintf(os.Stderr, "Tape reports %s free\n", humanBytes(int64(free)))
		if uint64(todoBytes) > free && !*force {
			return fmt.Errorf("not enough space: need %s, tape has %s free (use --force to try anyway)",
				humanBytes(todoBytes), humanBytes(int64(free)))
		}
	}
	if *dry {
		for _, it := range todo {
			fmt.Printf("%s -> %s\n", it.src, it.dest)
		}
		return nil
	}

	// Copy.
	var written []FileEntry
	var copyErr error
	if len(todo) > 0 {
		p := newProgress("Writing", int64(len(todo)), todoBytes)
		for _, it := range todo {
			h, err := copyFile(it, filepath.Join(mount, filepath.FromSlash(it.dest)), p)
			if err != nil {
				copyErr = fmt.Errorf("copying %s: %w", it.src, err)
				break
			}
			written = append(written, FileEntry{Path: it.dest, Size: it.size, Mtime: it.mtime.Unix(), SHA256: h})
			p.fileDone()
		}
		p.finish()
	} else {
		fmt.Fprintln(os.Stderr, "Nothing new to copy.")
	}

	// Record whatever made it, even after a failure, so the catalog matches the tape.
	all := append(written, already...)
	if len(all) == 0 {
		return copyErr
	}
	srcAbs := make([]string, len(sources))
	for i, s := range sources {
		srcAbs[i] = absPath(s)
	}
	meta := ManifestMeta{Barcode: bc, Name: nm, Source: "cli write " + strings.Join(srcAbs, " ")}
	if len(written) > 0 {
		onTape := filepath.Join(mount, tapeMetaDir, time.Now().UTC().Format("20060102T150405Z")+"-write.jsonl")
		if err := writeManifestFile(onTape, meta, written); err != nil {
			fmt.Fprintf(os.Stderr, "warning: couldn't write the manifest onto the tape: %v\n", err)
		}
	}
	res, err := upload(c, meta, all, "append")
	if err != nil {
		return errors.Join(copyErr, err)
	}
	printUploaded(res, "Recorded")
	if copyErr == nil {
		fmt.Println("Done. Unmount the tape (or eject it) so LTFS writes its index to the cartridge.")
	}
	return copyErr
}

// copyFile copies one file, hashing it on the way through, and keeps its
// modification time. Returns the SHA-256.
func copyFile(it copyItem, dst string, p *progress) (string, error) {
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return "", err
	}
	in, err := os.Open(it.src)
	if err != nil {
		return "", err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	buf := make([]byte, ioBufferSize)
	n, err := io.CopyBuffer(io.MultiWriter(out, h), &countingReader{in, p}, buf)
	if cerr := out.Close(); err == nil {
		err = cerr // on tape, errors can surface at close
	}
	if err == nil && n != it.size {
		err = fmt.Errorf("source changed size during copy (%d bytes, expected %d)", n, it.size)
	}
	if err != nil {
		os.Remove(dst)
		return "", err
	}
	if err := os.Chtimes(dst, it.mtime, it.mtime); err != nil {
		fmt.Fprintf(os.Stderr, "warning: couldn't set the time on %s: %v\n", dst, err)
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ------------------------------------------------------------------ verify

func cmdVerify(args []string) error {
	fl := newFlags("verify", "<mountpoint>",
		"Check a mounted tape against the catalog. Reads every file and compares SHA-256 hashes;\n"+
			"files the catalog has no hash for get one recorded. Exits with status 1 if anything is wrong.")
	barcode := fl.String("barcode", "", "tape barcode (default: read from LTFS)")
	quick := fl.Bool("quick", false, "only check that files exist with the right size (no reading)")
	cfg := fl.serverFlags()
	pos, err := fl.parse(args, 1, 1)
	if err != nil {
		return err
	}
	mount := pos[0]
	if err := checkMount(mount); err != nil {
		return err
	}
	bc, _, err := tapeIdentity(mount, *barcode, "")
	if err != nil {
		return err
	}
	c, err := cfg.client()
	if err != nil {
		return err
	}
	tape, err := c.GetTape(bc)
	if err != nil {
		return err
	}
	catalog, err := c.TapeFiles(tape.Barcode)
	if err != nil {
		return err
	}
	onTape, err := walkTape(mount)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "%s: catalog lists %d files, tape has %d\n", tape.Barcode, len(catalog), len(onTape))

	present := make(map[string]FileEntry, len(onTape))
	for _, e := range onTape {
		present[e.Path] = e
	}
	var missing, wrongSize, badHash, unreadable, extra []string
	var toRead []FileEntry
	var readBytes int64
	inCatalog := make(map[string]bool, len(catalog))
	for _, e := range catalog {
		inCatalog[e.Path] = true
		t, ok := present[e.Path]
		switch {
		case !ok:
			missing = append(missing, e.Path)
		case t.Size != e.Size:
			wrongSize = append(wrongSize, fmt.Sprintf("%s (catalog %d, tape %d)", e.Path, e.Size, t.Size))
		default:
			toRead = append(toRead, e)
			readBytes += e.Size
		}
	}
	for _, e := range onTape {
		if !inCatalog[e.Path] {
			extra = append(extra, e.Path)
		}
	}

	var learned []FileEntry
	if !*quick && len(toRead) > 0 {
		p := newProgress("Verifying", int64(len(toRead)), readBytes)
		for _, e := range sortForReading(mount, toRead) {
			h, err := hashFile(filepath.Join(mount, filepath.FromSlash(e.Path)), p)
			switch {
			case err != nil:
				unreadable = append(unreadable, fmt.Sprintf("%s (%v)", e.Path, err))
			case e.SHA256 == "":
				e.SHA256 = h
				learned = append(learned, e)
			case e.SHA256 != h:
				badHash = append(badHash, e.Path)
			}
			p.fileDone()
		}
		p.finish()
	}

	report := func(title string, list []string) {
		if len(list) == 0 {
			return
		}
		fmt.Printf("\n%s: %d\n", title, len(list))
		for i, s := range list {
			if i == 50 {
				fmt.Printf("  ... and %d more\n", len(list)-50)
				break
			}
			fmt.Printf("  %s\n", s)
		}
	}
	report("Missing from tape", missing)
	report("Wrong size", wrongSize)
	report("Hash mismatch (data differs from when it was cataloged)", badHash)
	report("Unreadable", unreadable)
	report("On tape but not in the catalog (run `tapewrangler index` to add them)", extra)

	ok := len(missing)+len(wrongSize)+len(badHash)+len(unreadable) == 0
	checked := len(toRead) - len(unreadable)
	fmt.Println()
	if *quick {
		fmt.Printf("Quick check: %d files present with the right size. File contents were not read.\n", len(toRead))
	} else {
		fmt.Printf("Read %d files: %d matched their stored hash, %d had no hash yet.\n",
			checked, checked-len(badHash)-len(learned), len(learned))
	}

	if len(learned) > 0 {
		meta := ManifestMeta{Barcode: tape.Barcode, Source: "cli verify (new hashes)"}
		if _, err := upload(c, meta, learned, "append"); err != nil {
			fmt.Fprintf(os.Stderr, "warning: couldn't record new hashes: %v\n", err)
		} else {
			fmt.Printf("Recorded %d new hashes.\n", len(learned))
		}
	}
	if !*quick {
		if err := c.RecordVerify(tape.Barcode, ok); err != nil {
			fmt.Fprintf(os.Stderr, "warning: couldn't record the result on the server: %v\n", err)
		}
	}
	if !ok {
		return errSilentFail
	}
	fmt.Println("OK")
	return nil
}

// -------------------------------------------------------------------- push

func cmdPush(args []string) error {
	fl := newFlags("push", "<manifest.jsonl>",
		"Send a saved file list to the server, e.g. one left behind after a failed upload.")
	barcode := fl.String("barcode", "", "tape barcode (default: from the manifest)")
	mode := fl.String("mode", "", "replace or append (default: from the file name, else replace)")
	cfg := fl.serverFlags()
	pos, err := fl.parse(args, 1, 1)
	if err != nil {
		return err
	}
	meta, entries, err := readManifestFile(pos[0])
	if err != nil {
		return err
	}
	if *barcode != "" {
		meta.Barcode = strings.ToUpper(*barcode)
	}
	if meta.Barcode == "" {
		return fmt.Errorf("the manifest doesn't say which tape it's for; pass --barcode")
	}
	m := *mode
	if m == "" {
		m = "replace"
		if strings.Contains(filepath.Base(pos[0]), "-append-") {
			m = "append"
		}
	}
	c, err := cfg.client()
	if err != nil {
		return err
	}
	var buf bytes.Buffer
	if err := writeManifest(&buf, meta, entries); err != nil {
		return err
	}
	res, err := c.Upload(meta.Barcode, m, meta.Name, meta.Source, &buf)
	if err != nil {
		return err
	}
	printUploaded(res, "Pushed")
	// A safety copy left by a failed upload has now done its job.
	if dir, err := configDir(); err == nil {
		if rel, err := filepath.Rel(filepath.Join(dir, "manifests"), absPath(pos[0])); err == nil && !strings.HasPrefix(rel, "..") {
			os.Remove(pos[0])
		}
	}
	return nil
}

// ------------------------------------------------------------ search/tapes

func cmdSearch(args []string) error {
	fl := newFlags("search", "<words>...", "Find files by name across all tapes.")
	per := fl.Int("n", 10, "matches to show per tape")
	cfg := fl.serverFlags()
	pos, err := fl.parse(args, 1, -1)
	if err != nil {
		return err
	}
	c, err := cfg.client()
	if err != nil {
		return err
	}
	r, err := c.Search(strings.Join(pos, " "), *per)
	if err != nil {
		return err
	}
	if r.TotalFiles == 0 {
		fmt.Println("No matches.")
		return nil
	}
	fmt.Printf("%d matching files (%s) on %d tapes\n", r.TotalFiles, humanBytes(r.TotalBytes), len(r.Tapes))
	for _, t := range r.Tapes {
		loc := "no location"
		if t.Location != nil {
			loc = *t.Location
		}
		fmt.Printf("\n%s  %s  [%s, %s]  %d matches, %s\n", t.Barcode, t.Name, loc, t.Status, t.MatchCount, humanBytes(t.MatchBytes))
		for _, f := range t.Files {
			fmt.Printf("    %-10s %s\n", humanBytes(f.Size), f.Path)
		}
		if int64(len(t.Files)) < t.MatchCount {
			fmt.Printf("    ... %d more\n", t.MatchCount-int64(len(t.Files)))
		}
	}
	return nil
}

func cmdTapes(args []string) error {
	fl := newFlags("tapes", "", "List the tapes in the catalog.")
	cfg := fl.serverFlags()
	if _, err := fl.parse(args, 0, 0); err != nil {
		return err
	}
	c, err := cfg.client()
	if err != nil {
		return err
	}
	tapes, err := c.ListTapes()
	if err != nil {
		return err
	}
	w := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "BARCODE\tNAME\tLOCATION\tSTATUS\tFILES\tUSED\tFULL")
	for _, t := range tapes {
		loc := "-"
		if t.Location != nil {
			loc = *t.Location
		}
		full := "-"
		if t.CapacityBytes != nil && *t.CapacityBytes > 0 {
			full = fmt.Sprintf("%.0f%%", 100*float64(t.UsedBytes)/(*t.CapacityBytes))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%d\t%s\t%s\n", t.Barcode, t.Name, loc, t.Status, t.FileCount, humanBytes(t.UsedBytes), full)
	}
	return w.Flush()
}

// ------------------------------------------------------------------- login

func cmdLogin(args []string) error {
	fl := newFlags("login", "<server-url>",
		"Save the server address and API token so other commands don't need them.")
	token := fl.String("token", "", "API token (default: ask)")
	pos, err := fl.parse(args, 1, 1)
	if err != nil {
		return err
	}
	server := strings.TrimRight(pos[0], "/")
	if !strings.Contains(server, "://") {
		server = "http://" + server
	}
	c := newClient(Config{Server: server})
	ver, required, _, err := c.Ping()
	if err != nil {
		return fmt.Errorf("couldn't reach %s: %w", server, err)
	}
	fmt.Printf("Connected to TapeWrangler %s\n", ver)
	tok := *token
	if tok == "" && required {
		fmt.Print("API token: ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		tok = strings.TrimSpace(line)
	}
	if required {
		c.cfg.Token = tok
		if _, _, valid, err := c.Ping(); err != nil || !valid {
			return fmt.Errorf("the server didn't accept that token")
		}
	} else {
		fmt.Println("note: this server doesn't require a token (TAPEWRANGLER_TOKEN isn't set on it)")
	}
	p, err := writeConfigFile(Config{Server: server, Token: tok})
	if err != nil {
		return err
	}
	fmt.Printf("Saved to %s\n", p)
	return nil
}

// ----------------------------------------------------------------- helpers

func absPath(p string) string {
	if a, err := filepath.Abs(p); err == nil {
		return a
	}
	return p
}

func joinSlash(parts ...string) string {
	var keep []string
	for _, p := range parts {
		if p = strings.Trim(p, "/"); p != "" {
			keep = append(keep, p)
		}
	}
	return strings.Join(keep, "/")
}
