// Command tapewrangler writes, indexes and verifies LTFS tapes, and keeps a
// TapeWrangler server's catalog up to date with what's on them.
package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"
)

// Set at build time: go build -ldflags "-X main.version=1.2.3"
var version = "dev"

// errSilentFail exits with status 1 after the command already printed why.
var errSilentFail = errors.New("")

const usage = `tapewrangler: keep track of what's on your tapes

Usage:
  tapewrangler login  <server-url>              save the server address and token
  tapewrangler write  <source>... <mountpoint>  copy onto a tape and catalog it
  tapewrangler index  <mountpoint>              catalog a tape that's already written
  tapewrangler verify <mountpoint>              re-read a tape and check it against the catalog
  tapewrangler push   <manifest.jsonl>          send a saved file list (after a failed upload)
  tapewrangler search <words>...                find files across all tapes
  tapewrangler tapes                            list tapes
  tapewrangler version

Run "tapewrangler <command> -h" for a command's options.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprint(os.Stderr, usage)
		os.Exit(2)
	}
	cmds := map[string]func([]string) error{
		"login": cmdLogin, "write": cmdWrite, "index": cmdIndex, "verify": cmdVerify,
		"push": cmdPush, "search": cmdSearch, "tapes": cmdTapes,
	}
	name, args := os.Args[1], os.Args[2:]
	switch name {
	case "version", "--version", "-v":
		fmt.Println("tapewrangler", version)
		return
	case "help", "--help", "-h":
		fmt.Print(usage)
		return
	}
	run, ok := cmds[name]
	if !ok {
		fmt.Fprintf(os.Stderr, "unknown command %q\n\n%s", name, usage)
		os.Exit(2)
	}
	if err := run(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			os.Exit(0)
		}
		var ue usageError
		if errors.As(err, &ue) {
			fmt.Fprintln(os.Stderr, "error:", ue.msg)
			os.Exit(2)
		}
		if err != errSilentFail {
			fmt.Fprintln(os.Stderr, "error:", err)
		}
		os.Exit(1)
	}
}

// --------------------------------------------------------- flag handling

type usageError struct{ msg string }

func (u usageError) Error() string { return u.msg }

type flags struct {
	*flag.FlagSet
	name string
}

func newFlags(name, positional, desc string) *flags {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Usage: tapewrangler %s [options] %s\n\n%s\n\nOptions:\n", name, positional, desc)
		fs.PrintDefaults()
	}
	return &flags{fs, name}
}

type serverOpts struct {
	server, token *string
}

func (f *flags) serverFlags() *serverOpts {
	return &serverOpts{
		server: f.String("server", "", "server URL (default: $TAPEWRANGLER_SERVER or the config file)"),
		token:  f.String("token", "", "API token (default: $TAPEWRANGLER_TOKEN or the config file)"),
	}
}

func (s *serverOpts) client() (*Client, error) {
	cfg, err := resolveConfig(*s.server, *s.token)
	if err != nil {
		return nil, err
	}
	if err := cfg.requireServer(); err != nil {
		return nil, err
	}
	return newClient(cfg), nil
}

// parse accepts options before or after the positional arguments (Go's flag
// package normally stops at the first non-option), then checks the count of
// positionals. max < 0 means no limit.
func (f *flags) parse(args []string, min, max int) ([]string, error) {
	var opts, pos []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if a == "--" {
			pos = append(pos, args[i+1:]...)
			break
		}
		if !strings.HasPrefix(a, "-") || a == "-" {
			pos = append(pos, a)
			continue
		}
		opts = append(opts, a)
		name := strings.TrimLeft(a, "-")
		if strings.Contains(name, "=") {
			continue
		}
		fl := f.Lookup(name)
		if fl == nil {
			continue // let flag report it
		}
		if bf, ok := fl.Value.(interface{ IsBoolFlag() bool }); ok && bf.IsBoolFlag() {
			continue
		}
		if i+1 < len(args) {
			i++
			opts = append(opts, args[i])
		}
	}
	if err := f.Parse(opts); err != nil {
		return nil, err
	}
	if len(pos) < min || (max >= 0 && len(pos) > max) {
		f.Usage()
		return nil, usageError{fmt.Sprintf("wrong number of arguments for %s", f.name)}
	}
	return pos, nil
}
