package main

import "os"

// handOffTarget is the hook build a dev Fleet's pane names in FLEET_HOOK_BIN,
// or "" to keep running this one. Claude Code runs the hook
// installed in its config folder, which a dev build never replaces, so a dev
// pane names its checkout's own build here. A path that is this binary, or
// that cannot be read, runs this one.
func handOffTarget(bin, self string) string {
	want, err := os.Stat(bin)
	if err != nil {
		return ""
	}
	if have, err := os.Stat(self); err == nil && os.SameFile(want, have) {
		return ""
	}
	return bin
}
