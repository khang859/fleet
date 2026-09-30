package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// TestMain mirrors the signal.Ignore(syscall.SIGINT) from main() so that
// tests can safely send SIGINT to themselves without killing the runner.
func TestMain(m *testing.M) {
	signal.Ignore(syscall.SIGINT)
	os.Exit(m.Run())
}

// startTestServer creates a Unix socket server that captures received events.
func startTestServer(t *testing.T, sock string) (events chan State, cleanup func()) {
	t.Helper()
	ch := make(chan State, 10)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			wg.Add(1)
			go func(c net.Conn) {
				defer wg.Done()
				defer c.Close()
				data, _ := io.ReadAll(c)
				if len(data) == 0 {
					return
				}
				var s State
				if json.Unmarshal(data, &s) == nil {
					ch <- s
				}
			}(conn)
		}
	}()

	return ch, func() {
		ln.Close()
		wg.Wait()
		close(ch)
	}
}

func TestSendEvent_StopStatus(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "test.sock")

	// Override the package-level socketPath for this test
	origPath := socketPath
	socketPath = sock
	defer func() { socketPath = origPath }()

	events, cleanup := startTestServer(t, sock)
	defer cleanup()

	state := &State{
		SessionID: "test-session",
		CWD:       "/tmp",
		Event:     "Stop",
		PID:       os.Getpid(),
		Status:    "waiting_for_input",
	}

	sendEvent(state, false)

	select {
	case got := <-events:
		if got.Status != "waiting_for_input" {
			t.Errorf("expected status waiting_for_input, got %s", got.Status)
		}
		if got.Event != "Stop" {
			t.Errorf("expected event Stop, got %s", got.Event)
		}
		if got.SessionID != "test-session" {
			t.Errorf("expected session_id test-session, got %s", got.SessionID)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestSendEvent_SessionEnd(t *testing.T) {
	dir := t.TempDir()
	sock := filepath.Join(dir, "test.sock")

	origPath := socketPath
	socketPath = sock
	defer func() { socketPath = origPath }()

	events, cleanup := startTestServer(t, sock)
	defer cleanup()

	state := &State{
		SessionID: "end-session",
		CWD:       "/tmp",
		Event:     "SessionEnd",
		PID:       os.Getpid(),
		Status:    "ended",
	}

	sendEvent(state, false)

	select {
	case got := <-events:
		if got.Status != "ended" {
			t.Errorf("expected status ended, got %s", got.Status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for event")
	}
}

func TestSendEvent_SurvivesSIGINT(t *testing.T) {
	// TestMain calls signal.Ignore(syscall.SIGINT), mirroring main().
	// This test verifies the process survives SIGINT and still delivers the event.
	dir := t.TempDir()
	sock := filepath.Join(dir, "test.sock")

	origPath := socketPath
	socketPath = sock
	defer func() { socketPath = origPath }()

	events, cleanup := startTestServer(t, sock)
	defer cleanup()

	state := &State{
		SessionID: "sigint-session",
		CWD:       "/tmp",
		Event:     "Stop",
		PID:       os.Getpid(),
		Status:    "waiting_for_input",
	}

	// Send SIGINT to our own process right before sending the event
	syscall.Kill(os.Getpid(), syscall.SIGINT)

	// The process should survive SIGINT and still send the event
	sendEvent(state, false)

	select {
	case got := <-events:
		if got.Status != "waiting_for_input" {
			t.Errorf("expected status waiting_for_input, got %s", got.Status)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("event not received after SIGINT - binary was killed by signal")
	}
}

func TestSendEvent_NoServer(t *testing.T) {
	// When no server is listening, sendEvent should return nil without panicking
	origPath := socketPath
	socketPath = filepath.Join(t.TempDir(), "nonexistent.sock")
	defer func() { socketPath = origPath }()

	result := sendEvent(&State{
		SessionID: "orphan",
		CWD:       "/tmp",
		Event:     "Stop",
		Status:    "waiting_for_input",
	}, false)

	if result != nil {
		t.Errorf("expected nil result when no server, got %+v", result)
	}
}

func TestStatusMapping(t *testing.T) {
	cases := []struct {
		event    string
		expected string
	}{
		{"UserPromptSubmit", "processing"},
		{"PreToolUse", "running_tool"},
		{"PostToolUse", "processing"},
		{"PostToolUseFailure", "processing"},
		{"PermissionRequest", "waiting_for_approval"},
		{"Notification", "notification"},
		{"Stop", "waiting_for_input"},
		// A subagent finishing must not read as the parent turn ending.
		{"SubagentStop", "subagent_stop"},
		{"SessionStart", "waiting_for_input"},
		{"SessionEnd", "ended"},
		{"PreCompact", "compacting"},
		{"SomethingNew", "unknown"},
	}

	for _, tc := range cases {
		t.Run(tc.event, func(t *testing.T) {
			if got := statusFor(tc.event); got != tc.expected {
				t.Errorf("%s: expected status %s, got %s", tc.event, tc.expected, got)
			}
		})
	}
}

func TestEmitSessionStartContext(t *testing.T) {
	var buf bytes.Buffer
	emitSessionStartContext(&buf)

	var out SessionStartOutput
	if err := json.Unmarshal(buf.Bytes(), &out); err != nil {
		t.Fatalf("output is not valid JSON: %v\noutput was: %q", err, buf.String())
	}
	if out.HookSpecificOutput.HookEventName != "SessionStart" {
		t.Errorf("expected hookEventName SessionStart, got %q", out.HookSpecificOutput.HookEventName)
	}
	if out.HookSpecificOutput.AdditionalContext == "" {
		t.Error("expected non-empty additionalContext")
	}
	wantPath := filepath.Join(homeDir(), ".fleet", "skills", "fleet.md")
	if !strings.Contains(out.HookSpecificOutput.AdditionalContext, wantPath) {
		t.Errorf("expected additionalContext to contain skill path %q, got %q",
			wantPath, out.HookSpecificOutput.AdditionalContext)
	}
}

func TestNewState_ForwardsPaneTranscriptAndConfigDir(t *testing.T) {
	var input HookInput
	payload := `{"session_id":"s1","hook_event_name":"SessionStart","cwd":"/repo",` +
		`"transcript_path":"/c/projects/-repo/s1.jsonl","source":"clear"}`
	if err := json.Unmarshal([]byte(payload), &input); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"FLEET_PANE_ID": "pane-7", "CLAUDE_CONFIG_DIR": "/c"}
	state := newState(&input, nil, 42, func(k string) string { return env[k] })

	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]interface{}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	want := map[string]interface{}{
		"pane_id":         "pane-7",
		"transcript_path": "/c/projects/-repo/s1.jsonl",
		"config_dir":      "/c",
		"source":          "clear",
		"protocol":        float64(protocolVersion),
		"pid":             float64(42),
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
}

func TestNewState_OmitsUnsetFields(t *testing.T) {
	input := HookInput{SessionID: "s1", HookEventName: "Stop", CWD: "/repo"}
	state := newState(&input, nil, 1, func(string) string { return "" })
	data, _ := json.Marshal(state)
	for _, key := range []string{"pane_id", "transcript_path", "config_dir", "source"} {
		if strings.Contains(string(data), `"`+key+`"`) {
			t.Errorf("%s should be omitted when empty: %s", key, data)
		}
	}
}

func TestClaudePID_StepsPastTheHookShell(t *testing.T) {
	comm := map[int]string{100: "claude", 200: "sh", 300: "/bin/bash", 400: "dash"}
	parent := map[int]int{200: 100, 300: 100, 400: 1}
	commOf := func(pid int) string { return comm[pid] }
	parentOf := func(pid int) int { return parent[pid] }

	cases := []struct {
		name string
		ppid int
		want int
	}{
		{"claude ran the hook directly", 100, 100},
		{"dash forked for sh -c", 200, 100},
		{"macOS ps reports a full path", 300, 100},
		{"a shell with no usable parent is kept", 400, 400},
		{"an unreadable parent is kept", 999, 999},
	}
	for _, c := range cases {
		if got := claudePID(c.ppid, commOf, parentOf); got != c.want {
			t.Errorf("%s: claudePID(%d) = %d, want %d", c.name, c.ppid, got, c.want)
		}
	}
}
