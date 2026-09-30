import type { ClaudeTrackingStatus } from '../../../shared/claude-sessions';
import { fence, type FleetToolOutput } from '../../../shared/fleet-tools';
import { oneLine } from '../../claude-sessions/brief';
import { describePhase, describeStarting, needsUser } from './format';
import type { FleetHost, FleetSession } from './host';

/** Why the list may be empty, for a model that cannot see the settings. */
function whyEmpty(status: ClaudeTrackingStatus): string {
  switch (status.state) {
    case 'off':
      return 'Session tracking is turned off in Fleet settings, so no session is seen.';
    case 'unsupported':
      return 'Session tracking is not available on this platform.';
    case 'failed':
      return `Session tracking could not start: ${status.detail}`;
    case 'starting':
      return 'Session tracking is still starting; try again in a moment.';
    case 'running':
      return 'A session is seen from its first prompt after Fleet started, so one started earlier appears once it is prompted again.';
  }
}

async function line(host: FleetHost, s: FleetSession, now: number): Promise<string> {
  const parts = [
    `${s.ref} · ${s.label}`,
    s.git?.branch ? `${s.projectName} on ${s.git.branch}` : s.projectName
  ];
  parts.push(describePhase(s, now) + (needsUser(s) ? ' · NEEDS THE USER' : ''));
  if (s.usage.costUsd !== null) parts.push(`~$${s.usage.costUsd.toFixed(2)}`);
  const goal = (await host.transcript(s.sessionId))?.brief.state.goal?.value;
  // The folder is what `fleet_spawn` needs to start a session beside this one.
  const text = `- ${parts.join(' · ')}\n  folder: ${s.cwd}`;
  return goal ? `${text}\n  goal: ${oneLine(goal, 200)}` : text;
}

/** `fleet_sessions`: every tracked session, one entry each. */
export async function listSessions(host: FleetHost): Promise<FleetToolOutput> {
  const sessions = host.sessions();
  const starting = host.starting();
  if (sessions.length === 0 && starting.length === 0) {
    const { status, installProblems } = host.tracking();
    const problems = installProblems.map(
      (p) => `Fleet could not install its hooks in ${p.configDir}: ${p.detail}`
    );
    return {
      text: [
        'No Claude Code sessions are running in Fleet panes.',
        whyEmpty(status),
        ...problems
      ].join('\n'),
      summary: 'no sessions'
    };
  }
  const now = host.now();
  const lines = [
    ...(await Promise.all(sessions.map(async (s) => line(host, s, now)))),
    ...starting.map((s) => `- ${s.ref} · ${s.label} · ${describeStarting(s, now)}`)
  ];
  const total = sessions.length + starting.length;
  const count = `${total} session${total === 1 ? '' : 's'}`;
  return {
    text: `${count}. Pass a ref to the other fleet tools.\n${fence('all', lines.join('\n'))}`,
    summary: count
  };
}
