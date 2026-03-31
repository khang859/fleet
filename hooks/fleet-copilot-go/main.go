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
	"strings"
	"syscall"
	"time"
)

const (
	timeoutSeconds = 300
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

func getTTY() *string {
	if runtime.GOOS == "windows" {
		return nil
	}
	ppid := os.Getppid()
	cmd := exec.Command("ps", "-p", fmt.Sprintf("%d", ppid), "-o", "tty=")
	out, err := cmd.Output()
	if err == nil {
		tty := strings.TrimSpace(string(out))
		if tty != "" && tty != "??" && tty != "-" {
			if !strings.HasPrefix(tty, "/dev/") {
				tty = "/dev/" + tty
			}
			return &tty
		}
	}
	return nil
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

	tty := getTTY()
	state := &State{
		SessionID: input.SessionID,
		CWD:       input.CWD,
		Event:     input.HookEventName,
		PID:       os.Getppid(),
		TTY:       tty,
	}

	switch input.HookEventName {
	case "UserPromptSubmit":
		state.Status = "processing"

	case "PreToolUse":
		state.Status = "running_tool"
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

	case "PostToolUse":
		state.Status = "processing"
		state.Tool = input.ToolName
		state.ToolInput = input.ToolInput
		state.ToolUseID = input.ToolUseID

	case "PermissionRequest":
		state.Status = "waiting_for_approval"
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
		} else {
			state.Status = "notification"
		}
		state.NotificationType = input.NotificationType
		state.Message = input.Message

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

	default:
		state.Status = "unknown"
	}

	sendEvent(state, false)
}
