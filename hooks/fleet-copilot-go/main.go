package main

import (
	"encoding/json"
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
	timeoutSeconds = 300
	// protocolVersion tells Fleet which fields this binary sends. Version 2 adds
	// pane_id, transcript_path, config_dir and source.
	protocolVersion = 2
)

var socketPath = func() string {
	name := "fleet-copilot.sock"
	if os.Getenv("FLEET_DEV") != "" {
		name = "fleet-copilot-dev.sock"
	}
	return filepath.Join(homeDir(), ".fleet", name)
}()

func homeDir() string {
	if h, err := os.UserHomeDir(); err == nil {
		return h
	}
	return os.Getenv("HOME")
}

type HookInput struct {
	SessionID        string                 `json:"session_id"`
	HookEventName    string                 `json:"hook_event_name"`
	CWD              string                 `json:"cwd"`
	ToolName         string                 `json:"tool_name,omitempty"`
	ToolInput        map[string]interface{} `json:"tool_input,omitempty"`
	ToolUseID        string                 `json:"tool_use_id,omitempty"`
	NotificationType string                 `json:"notification_type,omitempty"`
	Message          string                 `json:"message,omitempty"`
	TranscriptPath   string                 `json:"transcript_path,omitempty"`
	Source           string                 `json:"source,omitempty"`
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
	Protocol         int                    `json:"protocol"`
}

type PermissionDecision struct {
	HookSpecificOutput struct {
		HookEventName string `json:"hookEventName"`
		Decision      struct {
			Behavior string `json:"behavior"`
			Message  string `json:"message,omitempty"`
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
// input". Notification is refined by type in main.
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
		Protocol:       protocolVersion,
	}
}

func main() {
	// Ignore SIGINT so the hook binary survives Ctrl+C interrupts.
	// When the user presses Ctrl+C, SIGINT propagates to the entire
	// foreground process group. Without this, the binary is killed
	// before it can send the Stop/SubagentStop event to Fleet.
	signal.Ignore(syscall.SIGINT)

	if os.Getenv("FLEET_SESSION") == "" {
		os.Exit(0)
	}

	var input HookInput
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil {
		os.Exit(1)
	}

	pid := os.Getppid()
	if runtime.GOOS != "windows" {
		pid = claudePID(pid, psComm, psParent)
	}
	state := newState(&input, getTTY(pid), pid, os.Getenv)

	state.Status = statusFor(input.HookEventName)

	switch input.HookEventName {
	case "PreToolUse", "PostToolUse", "PostToolUseFailure":
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

	case "PermissionRequest":
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

		if state.Tool == "AskUserQuestion" {
			sendEvent(state, false)
			os.Exit(0)
		}

		resp := sendEvent(state, true)
		if resp != nil {
			var output PermissionDecision
			output.HookSpecificOutput.HookEventName = "PermissionRequest"

			switch resp.Decision {
			case "allow":
				output.HookSpecificOutput.Decision.Behavior = "allow"
			case "deny":
				output.HookSpecificOutput.Decision.Behavior = "deny"
				msg := resp.Reason
				if msg == "" {
					msg = "Denied by user via Fleet Copilot"
				}
				output.HookSpecificOutput.Decision.Message = msg
			default:
				os.Exit(0)
			}

			result, err := json.Marshal(output)
			if err == nil {
				fmt.Println(string(result))
			}
		}
		os.Exit(0)

	case "Notification":
		if input.NotificationType == "permission_prompt" {
			os.Exit(0)
		} else if input.NotificationType == "idle_prompt" {
			state.Status = "waiting_for_input"
		}
		state.NotificationType = input.NotificationType
		state.Message = input.Message

	case "SessionStart":
		emitSessionStartContext(os.Stdout)
	}

	sendEvent(state, false)
}
