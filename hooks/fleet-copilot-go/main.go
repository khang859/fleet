package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	// timeoutSeconds is how long a permission request waits for Fleet. Fleet
	// lets go a little sooner (PERMISSION_HOLD_MS in hook-server.ts); a test
	// there reads this value to keep the two in order.
	timeoutSeconds = 300
	// protocolVersion tells Fleet which fields this binary sends. Version 2 adds
	// pane_id, transcript_path, config_dir and source. Version 3 adds
	// prompt_sha256. Version 4 adds runtime and db_path, for eva. Version 5
	// adds cost_usd and rate_limits, and the StatusLine event.
	protocolVersion = 5
)

var socketPath = socketPathFrom(os.Getenv)

// socketPathFrom is where Fleet listens. Fleet names its socket in every pane
// it starts, as each dev checkout has its own; an older Fleet does not, and
// the name follows FLEET_DEV.
func socketPathFrom(getenv func(string) string) string {
	if path := getenv("FLEET_COPILOT_SOCKET"); path != "" {
		return path
	}
	name := "fleet-copilot.sock"
	if getenv("FLEET_DEV") != "" {
		name = "fleet-copilot-dev.sock"
	}
	return filepath.Join(homeDir(), ".fleet", name)
}

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

type HookInput struct {
	SessionID     string `json:"session_id"`
	HookEventName string `json:"hook_event_name"`
	CWD           string `json:"cwd"`
	ToolName      string `json:"tool_name,omitempty"`
	// ToolInput is an object, except that eva sends the model's arguments as
	// text when they are not JSON; toolInputOf keeps only an object.
	ToolInput        json.RawMessage `json:"tool_input,omitempty"`
	ToolUseID        string          `json:"tool_use_id,omitempty"`
	NotificationType string          `json:"notification_type,omitempty"`
	Message          string          `json:"message,omitempty"`
	TranscriptPath   string          `json:"transcript_path,omitempty"`
	Source           string          `json:"source,omitempty"`
	Error            string          `json:"error,omitempty"`
	ErrorDetails     string          `json:"error_details,omitempty"`
	Prompt           string          `json:"prompt,omitempty"`
	// LastAssistantMessage is set on StopFailure to the API error text.
	LastAssistantMessage string `json:"last_assistant_message,omitempty"`

	// eva's own fields: its pid, its sessions.db (empty when it saves
	// nothing), and on StopFailure the error's kind, text and the epoch
	// second a rate limit lifts.
	PID          int    `json:"pid,omitempty"`
	DBPath       string `json:"db_path,omitempty"`
	ErrorKind    string `json:"error_kind,omitempty"`
	ErrorMessage string `json:"error_message,omitempty"`
	RetryAfter   *int64 `json:"retry_after,omitempty"`
	// On eva's Stop: what the conversation cost so far, null when its server
	// reports no cost.
	Usage *struct {
		Cost *float64 `json:"cost"`
	} `json:"usage,omitempty"`
}

// StatusLineInput is the part of Claude Code's status line input Fleet
// reads: the session's cost so far and, on a subscription, its usage windows.
type StatusLineInput struct {
	SessionID string `json:"session_id"`
	CWD       string `json:"cwd"`
	Cost      *struct {
		TotalCostUSD *float64 `json:"total_cost_usd"`
	} `json:"cost,omitempty"`
	RateLimits *RateLimits `json:"rate_limits,omitempty"`
}

// RateLimits are Claude Code's subscription windows, passed on as it sends them.
type RateLimits struct {
	FiveHour *UsageWindow `json:"five_hour,omitempty"`
	SevenDay *UsageWindow `json:"seven_day,omitempty"`
}

type UsageWindow struct {
	UsedPercentage float64 `json:"used_percentage"`
	ResetsAt       int64   `json:"resets_at"`
}

type State struct {
	SessionID        string                 `json:"session_id"`
	CWD              string                 `json:"cwd"`
	Event            string                 `json:"event"`
	PID              int                    `json:"pid"`
	TTY              *string                `json:"tty"`
	Status           string                 `json:"status,omitempty"`
	Tool             string                 `json:"tool,omitempty"`
	ToolInput        map[string]interface{} `json:"tool_input,omitempty"`
	ToolUseID        string                 `json:"tool_use_id,omitempty"`
	NotificationType string                 `json:"notification_type,omitempty"`
	Message          string                 `json:"message,omitempty"`
	PaneID           string                 `json:"pane_id,omitempty"`
	TranscriptPath   string                 `json:"transcript_path,omitempty"`
	ConfigDir        string                 `json:"config_dir,omitempty"`
	Source           string                 `json:"source,omitempty"`
	Error            string                 `json:"error,omitempty"`
	ErrorDetails     string                 `json:"error_details,omitempty"`
	PromptSHA256     string                 `json:"prompt_sha256,omitempty"`
	Runtime          string                 `json:"runtime,omitempty"`
	DBPath           string                 `json:"db_path,omitempty"`
	CostUSD          *float64               `json:"cost_usd,omitempty"`
	RateLimits       *RateLimits            `json:"rate_limits,omitempty"`
	Protocol         int                    `json:"protocol"`
}

type PermissionDecision struct {
	HookSpecificOutput struct {
		HookEventName string `json:"hookEventName"`
		Decision      struct {
			Behavior     string          `json:"behavior"`
			Message      string          `json:"message,omitempty"`
			UpdatedInput json.RawMessage `json:"updatedInput,omitempty"`
		} `json:"decision"`
	} `json:"hookSpecificOutput"`
}

type SocketResponse struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason"`
}

const fleetSkillContextTemplate = "You're running inside Fleet. A `fleet` CLI is available (open files/images in Fleet tabs, annotate web pages, generate/edit AI images). Read %s for the full command reference before using it."

type SessionStartOutput struct {
	HookSpecificOutput struct {
		HookEventName     string `json:"hookEventName"`
		AdditionalContext string `json:"additionalContext"`
	} `json:"hookSpecificOutput"`
}

// emitSessionStartContext writes the Fleet skill pointer as SessionStart hook
// output. Claude Code reads this JSON from stdout and injects additionalContext
// into the session. The skill path is absolute (via homeDir) so Claude's Read
// tool can open it on any platform.
func emitSessionStartContext(w io.Writer) {
	skillPath := filepath.Join(homeDir(), ".fleet", "skills", "fleet.md")
	var out SessionStartOutput
	out.HookSpecificOutput.HookEventName = "SessionStart"
	out.HookSpecificOutput.AdditionalContext = fmt.Sprintf(fleetSkillContextTemplate, skillPath)
	data, err := json.Marshal(out)
	if err != nil {
		return
	}
	fmt.Fprintln(w, string(data))
}

// psField reads one `ps -o <field>=` column for a process, or "" when ps fails.
func psField(pid int, field string) string {
	out, err := exec.Command("ps", "-p", strconv.Itoa(pid), "-o", field+"=").Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func psComm(pid int) string { return psField(pid, "comm") }

func psParent(pid int) int {
	ppid, err := strconv.Atoi(psField(pid, "ppid"))
	if err != nil {
		return 0
	}
	return ppid
}

// Shells Claude Code may run a hook command through.
var hookShells = map[string]bool{"sh": true, "dash": true, "bash": true, "zsh": true}

// claudePID finds the Claude process that ran this hook. Claude Code runs hook
// commands through `sh -c`: bash execs a lone command in place, but dash (the
// /bin/sh of Debian and Ubuntu) forks, which leaves the short-lived shell as
// the parent. Fleet checks this pid for liveness, so it must be Claude's.
func claudePID(ppid int, commOf func(int) string, parentOf func(int) int) int {
	if !hookShells[filepath.Base(commOf(ppid))] {
		return ppid
	}
	if parent := parentOf(ppid); parent > 1 {
		return parent
	}
	return ppid
}

func getTTY(pid int) *string {
	if runtime.GOOS == "windows" {
		return nil
	}
	tty := psField(pid, "tty")
	if tty == "" || tty == "??" || tty == "-" {
		return nil
	}
	if !strings.HasPrefix(tty, "/dev/") {
		tty = "/dev/" + tty
	}
	return &tty
}

func sendEvent(state *State, waitForResponse bool) *SocketResponse {
	conn, err := net.DialTimeout("unix", socketPath, 5*time.Second)
	if err != nil {
		return nil
	}
	defer conn.Close()

	data, err := json.Marshal(state)
	if err != nil {
		return nil
	}

	_, err = conn.Write(data)
	if err != nil {
		return nil
	}

	if waitForResponse {
		// Half-close write side so server sees EOF and can process the event
		if uc, ok := conn.(*net.UnixConn); ok {
			uc.CloseWrite()
		}
		conn.SetReadDeadline(time.Now().Add(time.Duration(timeoutSeconds) * time.Second))
		data, err := io.ReadAll(conn)
		conn.Close()
		if err != nil || len(data) == 0 {
			return nil
		}
		var resp SocketResponse
		if json.Unmarshal(data, &resp) != nil {
			return nil
		}
		return &resp
	}

	return nil
}

// statusFor maps a Claude Code hook event to the status Fleet tracks.
//
// SubagentStop has its own status: a subagent finishing says nothing about
// whether the parent turn is done, so Fleet must not read it as "waiting for
// input". Notification is refined by type in main. StopFailure ends the turn
// like Stop, but on an API error such as a rate limit, which Fleet must tell
// apart from a turn that finished.
func statusFor(event string) string {
	switch event {
	case "UserPromptSubmit", "PostToolUse", "PostToolUseFailure":
		return "processing"
	case "PreToolUse":
		return "running_tool"
	case "PermissionRequest":
		return "waiting_for_approval"
	case "Notification":
		return "notification"
	case "Stop", "SessionStart":
		return "waiting_for_input"
	case "StopFailure":
		return "api_error"
	case "SubagentStop":
		return "subagent_stop"
	case "SessionEnd":
		return "ended"
	case "PreCompact":
		return "compacting"
	default:
		return "unknown"
	}
}

// promptHash is the sha256 of a submitted prompt, trimmed, so Fleet can check
// that the prompt it typed arrived as it was typed without the text itself
// crossing the socket.
func promptHash(prompt string) string {
	if prompt == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(strings.TrimSpace(prompt)))
	return hex.EncodeToString(sum[:])
}

// newState builds the event Fleet receives. The pane id comes from the
// environment Fleet gave the pane's shell, so Fleet can place the session
// without walking the process tree; the config dir lets Fleet find the
// transcript when Claude runs with CLAUDE_CONFIG_DIR.
func newState(input *HookInput, tty *string, pid int, getenv func(string) string) *State {
	return &State{
		SessionID:      input.SessionID,
		CWD:            input.CWD,
		Event:          input.HookEventName,
		PID:            pid,
		TTY:            tty,
		PaneID:         getenv("FLEET_PANE_ID"),
		TranscriptPath: input.TranscriptPath,
		ConfigDir:      getenv("CLAUDE_CONFIG_DIR"),
		Source:         input.Source,
		Error:          input.Error,
		ErrorDetails:   input.ErrorDetails,
		Message:        stopFailureText(input),
		PromptSHA256:   promptHash(input.Prompt),
		Protocol:       protocolVersion,
	}
}

// evaState is newState for an event eva sent: eva has no transcript file or
// Claude config dir, names its database instead, and reports an API error
// as a kind and a text.
func evaState(input *HookInput, tty *string, pid int, getenv func(string) string) *State {
	state := newState(input, tty, pid, getenv)
	state.Runtime = "eva"
	state.TranscriptPath = ""
	state.ConfigDir = ""
	state.DBPath = input.DBPath
	if input.HookEventName == "StopFailure" {
		state.Error = input.ErrorKind
		state.Message = evaFailureText(input)
	}
	return state
}

// evaFailureText is eva's error text, cut like Claude's, with the time a
// rate limit lifts after a bar, the form Fleet reads a reset time from.
func evaFailureText(input *HookInput) string {
	text := []rune(input.ErrorMessage)
	if len(text) > stopFailureMessageRunes {
		text = text[:stopFailureMessageRunes]
	}
	if input.RetryAfter != nil {
		return fmt.Sprintf("%s|%d", string(text), *input.RetryAfter)
	}
	return string(text)
}

// toolInputOf is a tool's input when it is a JSON object, else nil.
func toolInputOf(raw json.RawMessage) map[string]interface{} {
	var input map[string]interface{}
	if json.Unmarshal(raw, &input) != nil {
		return nil
	}
	return input
}

// runtimeArg reads `--runtime claude|eva`; claude when it is not given, and
// false for anything else, so a newer Fleet's runtime is not misread.
func runtimeArg(args []string) (string, bool) {
	flags := flag.NewFlagSet("fleet-copilot", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	name := flags.String("runtime", "claude", "")
	if flags.Parse(args) != nil {
		return "", false
	}
	switch *name {
	case "claude", "eva":
		return *name, true
	}
	return "", false
}

// needsInputToAllow are the tools whose dialog an allow closes only when it
// carries the input: for a tool that requires the person, a hook's bare allow
// does not dismiss it. The mod's permissionResult does the same.
var needsInputToAllow = map[string]bool{"ExitPlanMode": true}

// permissionOutput is the hook's answer to a permission request, in Claude
// Code's form, which eva takes too; nil when Fleet left it to the pane.
func permissionOutput(resp *SocketResponse, input *HookInput) []byte {
	if resp == nil {
		return nil
	}
	var output PermissionDecision
	output.HookSpecificOutput.HookEventName = "PermissionRequest"
	switch resp.Decision {
	case "allow":
		output.HookSpecificOutput.Decision.Behavior = "allow"
		if needsInputToAllow[input.ToolName] {
			// As received, so the plan keeps its keys in Claude Code's order.
			output.HookSpecificOutput.Decision.UpdatedInput = input.ToolInput
		}
	case "deny":
		output.HookSpecificOutput.Decision.Behavior = "deny"
		msg := resp.Reason
		if msg == "" {
			msg = "Denied by user via Fleet Copilot"
		}
		output.HookSpecificOutput.Decision.Message = msg
	default:
		return nil
	}
	result, err := json.Marshal(output)
	if err != nil {
		return nil
	}
	return result
}

// stopFailureMessageRunes caps the API error text a StopFailure forwards.
const stopFailureMessageRunes = 500

// stopFailureText is the API error text Claude Code shows when a turn ends on
// one, such as a usage limit with its reset time. Other events send none.
func stopFailureText(input *HookInput) string {
	if input.HookEventName != "StopFailure" {
		return ""
	}
	text := []rune(input.LastAssistantMessage)
	if len(text) > stopFailureMessageRunes {
		text = text[:stopFailureMessageRunes]
	}
	return string(text)
}

func main() {
	// Ignore SIGINT so the hook binary survives Ctrl+C interrupts.
	// When the user presses Ctrl+C, SIGINT propagates to the entire
	// foreground process group. Without this, the binary is killed
	// before it can send the Stop/SubagentStop event to Fleet.
	signal.Ignore(syscall.SIGINT)
	if self, err := os.Executable(); err == nil {
		if bin := handOffTarget(os.Getenv("FLEET_HOOK_BIN"), self); bin != "" {
			execHook(bin, os.Args[1:])
		}
	}
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Getenv, hookPID))
}

// hookPID is the pid of the program that ran this hook: the parent, past the
// shell a hook command runs through.
func hookPID() int {
	pid := os.Getppid()
	if runtime.GOOS != "windows" {
		pid = claudePID(pid, psComm, psParent)
	}
	return pid
}

// statusLine prints the line Fleet gave a crew member's pane and passes the
// session's cost and usage windows on to Fleet. Claude Code shows whatever
// it prints, so it prints the line even outside Fleet.
func statusLine(stdin io.Reader, stdout io.Writer, getenv func(string) string, parentPID func() int) int {
	fmt.Fprintln(stdout, getenv("FLEET_CREW_STATUS"))
	if getenv("FLEET_SESSION") == "" {
		return 0
	}
	var input StatusLineInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return 0
	}
	pid := parentPID()
	state := newState(&HookInput{SessionID: input.SessionID, CWD: input.CWD, HookEventName: "StatusLine"}, getTTY(pid), pid, getenv)
	state.Status = "status_line"
	if input.Cost != nil {
		state.CostUSD = input.Cost.TotalCostUSD
	}
	state.RateLimits = input.RateLimits
	sendEvent(state, false)
	return 0
}

// run handles one hook call and returns the exit code.
// hookState is the event's state for the runtime that sent it.
func hookState(runtimeName string, input *HookInput, getenv func(string) string, parentPID func() int) *State {
	if runtimeName != "eva" {
		pid := parentPID()
		return newState(input, getTTY(pid), pid, getenv)
	}
	// eva names its own pid; it runs hooks through `sh -c` too.
	pid := input.PID
	if pid == 0 {
		pid = parentPID()
	}
	state := evaState(input, getTTY(pid), pid, getenv)
	if input.HookEventName == "Stop" && input.Usage != nil {
		state.CostUSD = input.Usage.Cost
	}
	return state
}

func run(args []string, stdin io.Reader, stdout io.Writer, getenv func(string) string, parentPID func() int) int {
	if len(args) > 0 && args[0] == "statusline" {
		return statusLine(stdin, stdout, getenv, parentPID)
	}
	if getenv("FLEET_SESSION") == "" {
		return 0
	}
	runtimeName, ok := runtimeArg(args)
	if !ok {
		return 0
	}

	var input HookInput
	if err := json.NewDecoder(stdin).Decode(&input); err != nil {
		return 1
	}

	state := hookState(runtimeName, &input, getenv, parentPID)
	state.Status = statusFor(input.HookEventName)

	switch input.HookEventName {
	case "PreToolUse", "PostToolUse", "PostToolUseFailure":
		state.Tool = input.ToolName
		state.ToolInput = toolInputOf(input.ToolInput)
		state.ToolUseID = input.ToolUseID

	case "PermissionRequest":
		state.Tool = input.ToolName
		state.ToolInput = toolInputOf(input.ToolInput)
		state.ToolUseID = input.ToolUseID

		if state.Tool == "AskUserQuestion" {
			sendEvent(state, false)
			return 0
		}

		if out := permissionOutput(sendEvent(state, true), &input); out != nil {
			fmt.Fprintln(stdout, string(out))
		}
		return 0

	case "Notification":
		if input.NotificationType == "permission_prompt" {
			return 0
		} else if input.NotificationType == "idle_prompt" {
			state.Status = "waiting_for_input"
		}
		state.NotificationType = input.NotificationType
		state.Message = input.Message

	case "SessionStart":
		if runtimeName == "claude" {
			emitSessionStartContext(stdout)
		}
	}

	sendEvent(state, false)
	return 0
}
