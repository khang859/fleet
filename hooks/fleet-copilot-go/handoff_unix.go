//go:build !windows

package main

import (
	"os"
	"syscall"
)

// execHook replaces this process with the hook at bin. The pid stays the same,
// so the hook still finds Claude Code as its parent. Returns only on failure.
func execHook(bin string, args []string) {
	_ = syscall.Exec(bin, append([]string{bin}, args...), os.Environ())
}
