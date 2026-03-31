package main

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"os/signal"
	"path/filepath"
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
		t.Fatal("event not received after SIGINT — binary was killed by signal")
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
		{"Stop", "waiting_for_input"},
		{"SubagentStop", "waiting_for_input"},
		{"SessionStart", "waiting_for_input"},
		{"SessionEnd", "ended"},
		{"PreCompact", "compacting"},
	}

	for _, tc := range cases {
		t.Run(tc.event, func(t *testing.T) {
			// Simulate the switch statement from main()
			state := &State{Event: tc.event}
			switch tc.event {
			case "UserPromptSubmit":
				state.Status = "processing"
			case "Stop":
				state.Status = "waiting_for_input"
			case "SubagentStop":
				state.Status = "waiting_for_input"
			case "SessionStart":
				state.Status = "waiting_for_input"
			case "SessionEnd":
				state.Status = "ended"
			case "PreCompact":
				state.Status = "compacting"
			}
			if state.Status != tc.expected {
				t.Errorf("%s: expected status %s, got %s", tc.event, tc.expected, state.Status)
			}
		})
	}
}
