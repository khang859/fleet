import { basename } from 'node:path';
import type {
  ClaudeHookInstallProblem,
  ClaudeSessionView,
  ClaudeTrackingStatus
} from '../../../shared/claude-sessions';
import type { GitRunner } from '../../claude-sessions/git-probe';
import type { NotedInput } from '../../claude-sessions/registry';
import type { SessionTranscript } from '../../claude-sessions/session-transcripts';
import type { PanePlace } from '../../layout-store';

/**
 * Everything the fleet tools know about the Claude Code sessions, in one place.
 *
 * The Agent side reaches the session registry only through this, so the tools
 * can be tested against a plain object and the registry can change shape
 * without the tools noticing.
 */

/** A session as the fleet tools name it. */
export type FleetSession = ClaudeSessionView & {
  /**
   * The short name the model uses for it. Taken from the pane rather than the
   * session, so it survives `/clear` - which is what lets a read notice that
   * the session behind a ref was cleared.
   */
  ref: string;
  /** Where it runs, as the sessions panel names it. */
  label: string;
};

/** A pane `fleet_spawn` opened whose Claude Code session has not reported yet. */
export type FleetStarting = { ref: string; paneId: string; label: string; cwd: string; at: number };

export type FleetHost = {
  tracking(): { status: ClaudeTrackingStatus; installProblems: ClaudeHookInstallProblem[] };
  sessions(): FleetSession[];
  starting(): FleetStarting[];
  transcript(sessionId: string): Promise<SessionTranscript | null>;
  inputsFor(sessionId: string): NotedInput[];
  git: GitRunner;
  now(): number;
};

/** How many characters of a pane id make its ref. */
const REF_CHARS = 8;

export function sessionRef(paneId: string): string {
  return paneId.slice(0, REF_CHARS);
}

export function paneLabel(place: PanePlace | null, projectName: string): string {
  if (place === null) return projectName;
  const where = place.pane === null ? place.tab : `${place.tab} › ${place.pane}`;
  return `${place.workspaceName} › ${where}`;
}

/** The session behind a ref, or a reason the model can act on. */
export function resolveSession(host: FleetHost, ref: string): FleetSession {
  const needle = ref.trim();
  const found = host
    .sessions()
    .find((s) => s.ref === needle || s.paneId === needle || s.sessionId === needle);
  if (found === undefined) {
    throw new Error(
      `No session has the ref "${needle}". Call fleet_sessions for the sessions running now.`
    );
  }
  return found;
}

export type FleetHostSource = {
  snapshot(): {
    status: ClaudeTrackingStatus;
    installProblems: ClaudeHookInstallProblem[];
    sessions: ClaudeSessionView[];
  };
  transcript(sessionId: string): Promise<SessionTranscript | null>;
  inputsFor(sessionId: string): NotedInput[];
};

export function createFleetHost(deps: {
  sessions: FleetHostSource;
  starting: () => ReadonlyArray<{ paneId: string; cwd: string; at: number }>;
  placeOf: (paneId: string) => PanePlace | null;
  git: GitRunner;
  now?: () => number;
}): FleetHost {
  return {
    tracking: () => {
      const { status, installProblems } = deps.sessions.snapshot();
      return { status, installProblems };
    },
    sessions: () =>
      deps.sessions.snapshot().sessions.map((s) => ({
        ...s,
        ref: sessionRef(s.paneId),
        label: paneLabel(deps.placeOf(s.paneId), s.projectName)
      })),
    starting: () =>
      deps.starting().map((s) => ({
        ref: sessionRef(s.paneId),
        paneId: s.paneId,
        label: paneLabel(deps.placeOf(s.paneId), basename(s.cwd)),
        cwd: s.cwd,
        at: s.at
      })),
    transcript: async (sessionId) => deps.sessions.transcript(sessionId),
    inputsFor: (sessionId) => deps.sessions.inputsFor(sessionId),
    git: deps.git,
    now: deps.now ?? Date.now
  };
}
