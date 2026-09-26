//go:build darwin

package main

// macOS: the standard library doesn't wrap getxattr here, so ask the
// built-in `xattr` tool instead. LTFS on macOS uses attribute names without
// the "user." prefix.

import (
	"os/exec"
	"strings"
	"syscall"
)

func getxattr(path, name string) (string, bool) {
	for _, n := range []string{name, "user." + name} {
		out, err := exec.Command("xattr", "-p", n, path).Output()
		if err == nil && len(out) > 0 {
			return strings.TrimSpace(string(out)), true
		}
	}
	return "", false
}

func freeSpace(path string) (uint64, bool) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, false
	}
	return st.Bavail * uint64(st.Bsize), true
}
