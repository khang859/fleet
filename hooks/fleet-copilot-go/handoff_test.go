package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestHandOffTarget(t *testing.T) {
	dir := t.TempDir()
	self := filepath.Join(dir, "installed")
	dev := filepath.Join(dir, "dev")
	for _, path := range []string{self, dev} {
		if err := os.WriteFile(path, []byte(path), 0o755); err != nil {
			t.Fatal(err)
		}
	}

	cases := []struct {
		name string
		bin  string
		want string
	}{
		{"no dev build named", "", ""},
		{"the dev build", dev, dev},
		{"this binary itself", self, ""},
		{"a build that is missing", filepath.Join(dir, "gone"), ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := handOffTarget(c.bin, self)
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}
