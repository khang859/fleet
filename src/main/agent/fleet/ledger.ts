import { fence } from '../../../shared/fleet-tools';
import { oneLine } from '../../claude-sessions/brief';
import { describePhase, describeStarting, formatAge, needsUser } from './format';
import type { FleetHost } from './host';
import type { FleetLedgerEntry, FleetLedgerStore } from './ledger-store';

/** Settled entries still shown, so an answer that landed is seen once or twice. */
const RECENT_SETTLED = 5;
/** Sessions named at most, so a crowded workspace does not fill every round. */
const MAX_SESSION_LINES = 20;

function entryLine(entry: FleetLedgerEntry, now: number): string {
  const what =
    entry.action === 'send'
      ? `prompted ${entry.ref} ${formatAge(now - entry.at)} ago`
      : `started ${entry.ref} ${formatAge(now - entry.at)} ago`;
  const settled =
    entry.state === 'open'
      ? ''
      : ` · ${entry.state === 'answered' ? 'answered' : 'ended before answering'} ${formatAge(now - (entry.settledAt ?? now))} ago`;
  return [
    `- ${entry.id} ${what}${settled}`,
    `  why: ${oneLine(entry.why, 200)}`,
    `  expecting: ${oneLine(entry.expect, 200)}`,
    `  prompt: ${oneLine(entry.prompt, 120)}`
  ].join('\n');
}

/**
 * What this orchestrator conversation has asked of which session, and what
 * every session is doing now, for the end of each round.
 *
 * Kept by main and sent every round rather than left in the transcript, so
 * compaction cannot fold away a request still waiting on its answer. `null`
 * when there is nothing to say: no sessions and nothing asked.
 */
export function renderLedgerBlock(
  host: FleetHost,
  ledger: FleetLedgerStore,
  threadId: string
): string | null {
  const now = host.now();
  const sessions = host.sessions();
  const starting = host.starting();
  ledger.reconcile(threadId, sessions, new Set(starting.map((s) => s.paneId)), now);
  const entries = ledger.entries(threadId);
  const open = entries.filter((e) => e.state === 'open');
  const settled = entries
    .filter((e) => e.state !== 'open')
    .sort((a, b) => (b.settledAt ?? 0) - (a.settledAt ?? 0))
    .slice(0, RECENT_SETTLED);
  if (sessions.length === 0 && starting.length === 0 && entries.length === 0) return null;

  const parts: string[] = ['Your fleet ledger, kept by Fleet so it survives compaction.'];
  if (open.length > 0) {
    parts.push('', 'Waiting on:', ...open.map((e) => entryLine(e, now)));
  } else {
    parts.push('', 'Nothing you asked for is still outstanding.');
  }
  if (settled.length > 0) {
    parts.push('', 'Recently settled:', ...settled.map((e) => entryLine(e, now)));
  }
  if (sessions.length + starting.length > 0) {
    const lines = [
      ...sessions.map((s) => {
        const flag = needsUser(s) ? ' · NEEDS THE USER' : '';
        return `- ${s.ref} · ${s.label} · ${describePhase(s, now)}${flag}`;
      }),
      ...starting.map((s) => `- ${s.ref} · ${s.label} · ${describeStarting(s, now)}`)
    ];
    const shown = lines.slice(0, MAX_SESSION_LINES);
    const more = lines.length - shown.length;
    if (more > 0) shown.push(`- and ${more} more; fleet_sessions lists them all`);
    // Labels are the user's tab names, and a tab can be named anything.
    parts.push('', 'Sessions now:', fence('all', shown.join('\n')));
  } else {
    parts.push('', 'No Claude Code sessions are running in Fleet panes now.');
  }
  return parts.join('\n');
}
