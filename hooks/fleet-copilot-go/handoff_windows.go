//go:build windows

package main

// execHook does nothing on Windows, where Fleet does not track Claude Code
// sessions, so there is no dev build to hand off to.
func execHook(bin string, args []string) {}
