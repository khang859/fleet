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
		{"StopFailure", "api_error"},
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

// readInput parses a hook payload the way main does.
func readInput(t *testing.T, payload string) *HookInput {
	t.Helper()
	var input HookInput
	if err := json.Unmarshal([]byte(payload), &input); err != nil {
		t.Fatal(err)
	}
	return &input
}

func TestNewState_ForwardsPaneTranscriptAndConfigDir(t *testing.T) {
	input := readInput(t, `{"session_id":"s1","hook_event_name":"SessionStart","cwd":"/repo",`+
		`"transcript_path":"/c/projects/-repo/s1.jsonl","source":"clear"}`)
	env := map[string]string{"FLEET_PANE_ID": "pane-7", "CLAUDE_CONFIG_DIR": "/c"}
	state := newState(input, nil, 42, func(k string) string { return env[k] })

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

func TestNewState_ForwardsStopFailureError(t *testing.T) {
	input := readInput(t, `{"session_id":"s1","hook_event_name":"StopFailure","cwd":"/repo",`+
		`"error":"rate_limit","error_details":"429 Too Many Requests",`+
		`"last_assistant_message":"API Error: Rate limit reached"}`)
	state := newState(input, nil, 1, func(string) string { return "" })
	if state.Error != "rate_limit" || state.ErrorDetails != "429 Too Many Requests" {
		t.Errorf("error = %q, details = %q", state.Error, state.ErrorDetails)
	}
	if state.Message != "API Error: Rate limit reached" {
		t.Errorf("message = %q, want the API error text", state.Message)
	}
}

func TestNewState_SendsAssistantTextOnlyOnStopFailure(t *testing.T) {
	input := readInput(t, `{"session_id":"s1","hook_event_name":"Stop","cwd":"/repo",`+
		`"last_assistant_message":"Here is the plan for your secret project"}`)
	if state := newState(input, nil, 1, func(string) string { return "" }); state.Message != "" {
		t.Errorf("message = %q, want none on Stop", state.Message)
	}
	long := strings.Repeat("é", stopFailureMessageRunes+10)
	input = readInput(t, `{"session_id":"s1","hook_event_name":"StopFailure","cwd":"/repo",`+
		`"error":"rate_limit","last_assistant_message":"`+long+`"}`)
	if got := []rune(newState(input, nil, 1, func(string) string { return "" }).Message); len(got) != stopFailureMessageRunes {
		t.Errorf("message has %d runes, want %d", len(got), stopFailureMessageRunes)
	}
}

func TestNewState_ForwardsPromptHashNotText(t *testing.T) {
	input := readInput(t, `{"session_id":"s1","hook_event_name":"UserPromptSubmit","cwd":"/repo",`+
		`"prompt":"  [admiral] Build the toggle.\nKeep it small.\n"}`)
	state := newState(input, nil, 1, func(string) string { return "" })
	// The same value Fleet's hashPrompt gives the text Fleet typed (hook-events.test.ts).
	const want = "6f89735c79e3511775b5bcaccc42af7c104e2765fad1562204beddd44b8cee94"
	if state.PromptSHA256 != want {
		t.Errorf("prompt_sha256 = %q, want %q", state.PromptSHA256, want)
	}
	data, _ := json.Marshal(state)
	if strings.Contains(string(data), "Build the toggle") {
		t.Errorf("the prompt text crossed the socket: %s", data)
	}
}

func TestNewState_OmitsUnsetFields(t *testing.T) {
	input := HookInput{SessionID: "s1", HookEventName: "Stop", CWD: "/repo"}
	state := newState(&input, nil, 1, func(string) string { return "" })
	data, _ := json.Marshal(state)
	for _, key := range []string{"pane_id", "transcript_path", "config_dir", "source", "error", "error_details", "prompt_sha256"} {
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

func TestRuntimeArg(t *testing.T) {
	cases := []struct {
		args []string
		want string
		ok   bool
	}{
		{nil, "claude", true},
		{[]string{"--runtime", "eva"}, "eva", true},
		{[]string{"--runtime=claude"}, "claude", true},
		{[]string{"--runtime", "codex"}, "", false},
		{[]string{"--color"}, "", false},
	}
	for _, c := range cases {
		got, ok := runtimeArg(c.args)
		if got != c.want || ok != c.ok {
			t.Errorf("runtimeArg(%v) = %q, %v; want %q, %v", c.args, got, ok, c.want, c.ok)
		}
	}
}

func TestEvaState_NamesRuntimeDatabaseAndLimitReset(t *testing.T) {
	input := readInput(t, `{"session_id":"e1","hook_event_name":"StopFailure","cwd":"/w","pid":4242,
		"db_path":"/home/u/.eva/sessions.db","error_kind":"rate_limit",
		"error_message":"Too many requests","retry_after":1760000000,
		"transcript_path":"/x.jsonl"}`)
	env := map[string]string{"FLEET_PANE_ID": "pane-1", "CLAUDE_CONFIG_DIR": "/c"}
	state := evaState(input, nil, 4242, func(k string) string { return env[k] })

	if state.Runtime != "eva" || state.DBPath != "/home/u/.eva/sessions.db" || state.PID != 4242 {
		t.Fatalf("runtime, db path or pid not forwarded: %+v", state)
	}
	if state.TranscriptPath != "" || state.ConfigDir != "" {
		t.Errorf("eva has no transcript file or Claude config dir: %+v", state)
	}
	if state.Error != "rate_limit" || state.Message != "Too many requests|1760000000" {
		t.Errorf("error = %q, message = %q", state.Error, state.Message)
	}
}

func TestEvaFailureText_KeepsResetTimeAfterTheCut(t *testing.T) {
	retry := int64(1760000000)
	input := &HookInput{ErrorMessage: strings.Repeat("x", 900), RetryAfter: &retry}
	got := evaFailureText(input)
	if !strings.HasSuffix(got, "|1760000000") || len([]rune(got)) != stopFailureMessageRunes+11 {
		t.Errorf("got %d runes ending %q", len([]rune(got)), got[len(got)-12:])
	}
	if evaFailureText(&HookInput{ErrorMessage: "down"}) != "down" {
		t.Error("no reset time should add no bar")
	}
}

func TestToolInputOf_TextIsNotFatal(t *testing.T) {
	input := readInput(t, `{"session_id":"e1","hook_event_name":"PreToolUse","tool_input":"not json"}`)
	if toolInputOf(input.ToolInput) != nil {
		t.Error("text input should give no object")
	}
	input = readInput(t, `{"session_id":"e1","hook_event_name":"PreToolUse","tool_input":{"command":"ls"}}`)
	if toolInputOf(input.ToolInput)["command"] != "ls" {
		t.Error("object input should be kept")
	}
}

// startAnsweringServer is a socket that answers each event with `answer`.
func startAnsweringServer(t *testing.T, answer string) chan State {
	t.Helper()
	// A short folder: a unix socket path has a 104-byte limit on macOS.
	dir, err := os.MkdirTemp("", "fh")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	sock := filepath.Join(dir, "a.sock")
	origPath := socketPath
	socketPath = sock
	t.Cleanup(func() { socketPath = origPath })
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { ln.Close() })
	ch := make(chan State, 4)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			data, _ := io.ReadAll(conn)
			var s State
			if json.Unmarshal(data, &s) == nil {
				ch <- s
			}
			conn.Write([]byte(answer))
			conn.Close()
		}
	}()
	return ch
}

func runHook(t *testing.T, args []string, payload string) (int, string) {
	t.Helper()
	env := map[string]string{"FLEET_SESSION": "1", "FLEET_PANE_ID": "pane-1"}
	var out bytes.Buffer
	code := run(args, strings.NewReader(payload), &out, func(k string) string { return env[k] }, func() int { return 1 })
	return code, out.String()
}

func TestRun_EvaPermissionPrintsTheAnswerEvaTakes(t *testing.T) {
	events := startAnsweringServer(t, `{"decision":"allow"}`)
	code, out := runHook(t, []string{"--runtime", "eva"}, `{"session_id":"e1","hook_event_name":"PermissionRequest",
		"cwd":"/w","pid":77,"db_path":"/d","tool_name":"bash","tool_input":{"command":"git push"},"tool_use_id":"call_1"}`)

	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	want := `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}`
	if strings.TrimSpace(out) != want {
		t.Errorf("stdout = %q", out)
	}
	sent := <-events
	if sent.Runtime != "eva" || sent.Status != "waiting_for_approval" || sent.ToolUseID != "call_1" ||
		sent.PID != 77 || sent.Protocol != protocolVersion || sent.ToolInput["command"] != "git push" {
		t.Errorf("sent %+v", sent)
	}
}

func TestRun_DenyCarriesTheReason(t *testing.T) {
	startAnsweringServer(t, `{"decision":"deny","reason":"not in the plan"}`)
	_, out := runHook(t, []string{"--runtime", "eva"}, `{"session_id":"e1","hook_event_name":"PermissionRequest","tool_name":"bash","tool_use_id":"c"}`)
	if !strings.Contains(out, `"behavior":"deny","message":"not in the plan"`) {
		t.Errorf("stdout = %q", out)
	}
}

func TestRun_EvaSessionStartPrintsNothing(t *testing.T) {
	events := startAnsweringServer(t, ``)
	_, out := runHook(t, []string{"--runtime", "eva"}, `{"session_id":"e1","hook_event_name":"SessionStart","source":"startup","pid":5}`)
	if out != "" {
		t.Errorf("eva takes no context from a hook: %q", out)
	}
	if sent := <-events; sent.Status != "waiting_for_input" || sent.Runtime != "eva" {
		t.Errorf("sent %+v", sent)
	}
}

func TestRun_ClaudeEventsAreUnchanged(t *testing.T) {
	events := startAnsweringServer(t, ``)
	_, out := runHook(t, nil, `{"session_id":"c1","hook_event_name":"SessionStart","transcript_path":"/t.jsonl"}`)
	if !strings.Contains(out, "additionalContext") {
		t.Errorf("Claude still gets the Fleet skill pointer: %q", out)
	}
	if sent := <-events; sent.Runtime != "" || sent.TranscriptPath != "/t.jsonl" || sent.PID != 1 {
		t.Errorf("sent %+v", sent)
	}
}

func TestRun_UnknownRuntimeAndNoFleetSessionDoNothing(t *testing.T) {
	if code, out := runHook(t, []string{"--runtime", "codex"}, `{}`); code != 0 || out != "" {
		t.Errorf("unknown runtime: %d %q", code, out)
	}
	var out bytes.Buffer
	code := run(nil, strings.NewReader("not json"), &out, func(string) string { return "" }, func() int { return 1 })
	if code != 0 || out.Len() != 0 {
		t.Errorf("outside Fleet the hook must do nothing: %d %q", code, out.String())
	}
}

func TestRun_StatusLinePrintsTheCrewLineAndSendsTheSpend(t *testing.T) {
	events := startAnsweringServer(t, ``)
	env := map[string]string{"FLEET_SESSION": "1", "FLEET_PANE_ID": "pane-1", "FLEET_CREW_STATUS": "J4 · builder 1"}
	var out bytes.Buffer
	code := run([]string{"statusline"}, strings.NewReader(`{"session_id":"c1","cwd":"/w",
		"cost":{"total_cost_usd":0.42},
		"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1738425600}}}`),
		&out, func(k string) string { return env[k] }, func() int { return 1 })

	if code != 0 || out.String() != "J4 · builder 1\n" {
		t.Fatalf("exit %d, stdout %q", code, out.String())
	}
	sent := <-events
	if sent.Event != "StatusLine" || sent.Status != "status_line" || sent.SessionID != "c1" ||
		sent.PaneID != "pane-1" || sent.CostUSD == nil || *sent.CostUSD != 0.42 || sent.Protocol != protocolVersion {
		t.Errorf("sent %+v", sent)
	}
	if sent.RateLimits == nil || sent.RateLimits.FiveHour == nil || sent.RateLimits.FiveHour.UsedPercentage != 23.5 ||
		sent.RateLimits.FiveHour.ResetsAt != 1738425600 || sent.RateLimits.SevenDay != nil {
		t.Errorf("rate limits %+v", sent.RateLimits)
	}
}

func TestRun_StatusLineOutsideFleetOnlyPrints(t *testing.T) {
	var out bytes.Buffer
	code := run([]string{"statusline"}, strings.NewReader("not json"), &out,
		func(k string) string { return map[string]string{"FLEET_CREW_STATUS": "x"}[k] }, func() int { return 1 })
	if code != 0 || out.String() != "x\n" {
		t.Errorf("exit %d, stdout %q", code, out.String())
	}
}

func TestRun_EvaStopCarriesTheCost(t *testing.T) {
	events := startAnsweringServer(t, ``)
	runHook(t, []string{"--runtime", "eva"}, `{"session_id":"e1","hook_event_name":"Stop","pid":5,"usage":{"cost":1.25,"max_cost":null}}`)
	if sent := <-events; sent.CostUSD == nil || *sent.CostUSD != 1.25 {
		t.Errorf("sent %+v", sent)
	}
	runHook(t, []string{"--runtime", "eva"}, `{"session_id":"e1","hook_event_name":"Stop","pid":5,"usage":{"cost":null}}`)
	if sent := <-events; sent.CostUSD != nil {
		t.Errorf("an unknown cost stays unset: %v", *sent.CostUSD)
	}
}

func envOf(vars map[string]string) func(string) string {
	return func(key string) string { return vars[key] }
}

func TestSocketPathFrom_PrefersTheSocketFleetNames(t *testing.T) {
	got := socketPathFrom(envOf(map[string]string{
		"FLEET_COPILOT_SOCKET": "/x/fleet-copilot.sock",
		"FLEET_DEV":            "1",
	}))
	if got != "/x/fleet-copilot.sock" {
		t.Fatalf("got %q", got)
	}
}

func TestSocketPathFrom_FallsBackToTheDevName(t *testing.T) {
	got := socketPathFrom(envOf(map[string]string{"FLEET_DEV": "1"}))
	if filepath.Base(got) != "fleet-copilot-dev.sock" {
		t.Fatalf("got %q", got)
	}
}
