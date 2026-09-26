//go:build !linux && !darwin

package main

// Windows and others: no extended-attribute support here, so the barcode has
// to be given with --barcode, and reads happen in path order.

func getxattr(path, name string) (string, bool) { return "", false }

func freeSpace(path string) (uint64, bool) { return 0, false }
