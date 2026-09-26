//go:build linux

package main

// Linux: LTFS exposes tape details as extended attributes in the "user."
// namespace, readable with `getfattr -d -m - /mnt/tape`.

import (
	"strings"
	"syscall"
)

func getxattr(path, name string) (string, bool) {
	buf := make([]byte, 256)
	for _, n := range []string{"user." + name, name} {
		sz, err := syscall.Getxattr(path, n, buf)
		if err == nil && sz > 0 {
			return strings.TrimRight(string(buf[:sz]), "\x00\n "), true
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
