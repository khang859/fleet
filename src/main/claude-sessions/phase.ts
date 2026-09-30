import type {
  ClaudePendingPermission,
  ClaudeSessionPhase,
  ClaudeWaitingKind
} from '../../shared/claude-sessions';

/** The part of a session that hook events move. */
export type PhaseState = {
  phase: ClaudeSessionPhase;
  waitingKind: ClaudeWaitingKind | null;
  pendingPermissions: ClaudePendingPermission[];
};

/** One hook event, with a permission's tool use id already resolved. */
export type PhaseInput = {
  sessionId: string;
  event: string;
  status: string;
  tool?: string;
  toolInput?: Record<string, unknown>;
  toolUseId?: string;
  notificationType?: string;
  at: number;
};

export const INITIAL_PHASE: PhaseState = {
  phase: 'starting',
  waitingKind: null,
  pendingPermissions: []
};

/**
 * The phase a hook status moves a session to, or `null` when the event says
 * nothing about the phase and the session keeps the one it has.
 *
 * A subagent finishing, a notification, or a status from a newer hook binary
 * must not flip a working session to idle or waiting. `SubagentStop` is checked
 * by event name too, because hook binaries built before it had its own status
 * still send `waiting_for_input` for it.
 */
function statusToPhase(event: string, status: string): ClaudeSessionPhase | null {
  if (event === 'SubagentStop') return null;
  switch (status) {
    case 'processing':
    case 'running_tool':
      return 'processing';
    case 'waiting_for_input':
      return 'waitingForInput';
    case 'waiting_for_approval':
      return 'waitingForApproval';
    case 'compacting':
      return 'compacting';
    case 'ended':
      return 'ended';
    default:
      return null;
  }
}

/**
 * An open question stays open through an idle notification: Claude Code sends
 * `idle_prompt` after a quiet minute whatever is on screen, and that must not
 * turn a question dialog into a free-text prompt.
 */
function waitingKindFor(
  phase: ClaudeSessionPhase,
  asksQuestion: boolean,
  event: string,
  current: ClaudeWaitingKind | null
): ClaudeWaitingKind | null {
  if (phase !== 'waitingForInput') return null;
  if (asksQuestion) return 'question';
  if (event === 'Notification' && current === 'question') return 'question';
  return 'prompt';
}

/** A tool ran to the end, successfully or not. */
export const TOOL_FINISHED = new Set(['PostToolUse', 'PostToolUseFailure']);

/** Events after which no tool can still be waiting on a permission answer. */
export const TURN_BOUNDARIES = new Set(['UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd']);

/** Apply one hook event to a session's phase. Pure: `state` is not modified. */
export function reducePhase(state: PhaseState, input: PhaseInput): PhaseState {
  let phase = statusToPhase(input.event, input.status);
  let asksQuestion = false;
  let pendingPermissions = state.pendingPermissions;

  if (TURN_BOUNDARIES.has(input.event)) pendingPermissions = [];

  if (input.status === 'waiting_for_approval' && input.tool) {
    if (input.tool === 'AskUserQuestion') {
      // A question is answered in the dialog, not approved: it waits for input.
      phase = 'waitingForInput';
      asksQuestion = true;
    } else {
      const toolUseId = input.toolUseId ?? `unknown-${input.at}`;
      pendingPermissions = [
        ...pendingPermissions.filter((p) => p.toolUseId !== toolUseId),
        {
          sessionId: input.sessionId,
          toolUseId,
          tool: {
            toolName: input.tool,
            toolInput: input.toolInput ?? {},
            toolUseId: input.toolUseId
          },
          receivedAt: input.at
        }
      ];
    }
  }

  if (TOOL_FINISHED.has(input.event) && input.toolUseId) {
    const answered = input.toolUseId;
    pendingPermissions = pendingPermissions.filter((p) => p.toolUseId !== answered);
  }

  // Work on a parallel tool does not answer the one blocked on approval.
  if (phase === 'processing' && pendingPermissions.length > 0) phase = 'waitingForApproval';

  if (!phase) {
    return pendingPermissions === state.pendingPermissions
      ? state
      : { ...state, pendingPermissions };
  }
  return {
    phase,
    waitingKind: waitingKindFor(phase, asksQuestion, input.event, state.waitingKind),
    pendingPermissions
  };
}

/**
 * Drop a permission that was answered outside the event stream: from Fleet, or
 * in the terminal (the hook's socket closes). The session goes back to work
 * once nothing is left to approve.
 */
export function resolvePermission(state: PhaseState, toolUseId: string): PhaseState {
  const pendingPermissions = state.pendingPermissions.filter((p) => p.toolUseId !== toolUseId);
  if (pendingPermissions.length === state.pendingPermissions.length) return state;
  const phase =
    pendingPermissions.length === 0 && state.phase === 'waitingForApproval'
      ? 'processing'
      : state.phase;
  return { ...state, phase, pendingPermissions };
}

/** Which session a pane last ran, and in which epoch. */
export type PaneEpoch = { sessionId: string; epoch: number };

/**
 * The epoch an event's session belongs to in its pane.
 *
 * A new session id in a pane that already ran one is a fresh conversation in
 * the same place, as `/clear` makes: the epoch goes up and the old session is
 * returned in `replaces` so it can be ended.
 */
export function nextPaneEpoch(
  current: PaneEpoch | undefined,
  sessionId: string
): PaneEpoch & { replaces: string | null } {
  if (!current) return { sessionId, epoch: 1, replaces: null };
  if (current.sessionId === sessionId) return { ...current, replaces: null };
  return { sessionId, epoch: current.epoch + 1, replaces: current.sessionId };
}
