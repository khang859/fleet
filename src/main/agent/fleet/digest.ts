import { attentionKey, type ClaudeSession } from '../../../shared/claude-sessions';
import { FLEET_CHAIN_LIMIT, fence, type FleetDigestPull } from '../../../shared/fleet-tools';
import { toolInputPreview } from '../../claude-sessions/transcript';
import { describeAttention, type AttentionItem, type FleetAttention } from './attention';
import { sessionRef, type FleetHost, type FleetSession } from './host';
import { ledgerEntryLine } from './ledger';
import type { FleetLedgerStore } from './ledger-store';
import { readBriefDelta, type FleetCursors } from './read';

/**
 * Wakeup digests: what an orchestrator pane is told when sessions it looks
 * after need attention and it is not already waiting on them.
 */

/** Sessions described in one digest; the rest are counted. */
const MAX_SESSIONS = 6;
/** Roughly the most one session's part of a digest takes. */
const SESSION_CHARS = 1_200;
/** The least room left for what changed, however much else a session has to say. */
const MIN_BRIEF_CHARS = 400;

export type FleetDigestDeps = {
  host: FleetHost;
  ledger: FleetLedgerStore;
  attention: FleetAttention;
};

/**
 * Whether an attention change is still worth waking for. A session that has
 * moved on since - prompted again by the user, say - is not; an ending always
 * is, even once the session has left the registry.
 */
function stillNews(item: AttentionItem, sessions: readonly FleetSession[]): boolean {
  if (item.session === null) return !sessions.some((s) => s.paneId === item.paneId);
  if (item.session.phase === 'ended') return true;
  const current = sessions.find((s) => s.sessionId === item.sessionId);
  return current !== undefined && attentionKey(current) === attentionKey(item.session);
}

/** The permission a session waits on, as a line of its own data. */
function pendingApproval(session: ClaudeSession): string | null {
  if (session.phase !== 'waitingForApproval') return null;
  const asks = session.pendingPermissions.map((p) => {
    const preview = toolInputPreview(p.tool.toolName, p.tool.toolInput);
    return `${p.tool.toolName}${preview === '' ? '' : `: ${preview}`}`;
  });
  if (asks.length === 0) return null;
  return `Waiting for the user to allow or deny: ${asks.join('; ')}`;
}

async function sessionPart(
  deps: FleetDigestDeps,
  threadId: string,
  cursors: FleetCursors,
  item: AttentionItem,
  now: number
): Promise<{ headline: string; detail: string }> {
  const current = deps.host.sessions().find((s) => s.paneId === item.paneId);
  const ref = current?.ref ?? sessionRef(item.paneId);
  const name = current === undefined ? ref : `${ref} (${current.label})`;
  const headline = `${name} ${describeAttention(item.session)}.`;

  const approval = item.session === null ? null : pendingApproval(item.session);
  const entry = deps.ledger.entries(threadId).findLast((e) => e.paneId === item.paneId);
  const extra = [
    approval === null ? null : fence(ref, approval),
    entry === undefined ? null : `Ledger:\n${ledgerEntryLine(entry, now)}`
  ].filter((part): part is string => part !== null);
  const room = Math.max(MIN_BRIEF_CHARS, SESSION_CHARS - extra.join('\n').length);
  const changed =
    current?.sessionId === item.sessionId
      ? await readBriefDelta(deps.host, cursors, current, room).catch(() => null)
      : null;
  return {
    headline,
    detail: [`${name}:`, ...(changed === null ? [] : [changed]), ...extra].join('\n')
  };
}

/**
 * The digest for one orchestrator conversation, or why there is none.
 *
 * Takes everything that needs attention since its last digest, and moves past
 * it, whether or not any of it made it in: a session a wait is covering is the
 * wait's to report. At the chain limit nothing is taken, so what happened is
 * still there for the first digest after the user writes.
 */
export async function pullDigest(
  deps: FleetDigestDeps,
  threadId: string
): Promise<FleetDigestPull> {
  const { host, ledger, attention } = deps;
  if (ledger.chain(threadId) >= FLEET_CHAIN_LIMIT) return { text: null, paused: true };
  const sessions = host.sessions();
  const items = attention.pending(threadId).filter((item) => stillNews(item, sessions));
  attention.advance(threadId);
  if (items.length === 0) return { text: null, paused: false };

  const now = host.now();
  ledger.reconcile(threadId, sessions, new Set(host.starting().map((s) => s.paneId)), now);
  // The Orchestrator's own read cursors: a digest is a read done for it.
  const cursors: FleetCursors = {
    get: (ref) => ledger.cursor(threadId, ref),
    set: (ref, cursor) => ledger.setCursor(threadId, ref, cursor)
  };
  const shown = items.slice(0, MAX_SESSIONS);
  const parts = await Promise.all(
    shown.map(async (item) => sessionPart(deps, threadId, cursors, item, now))
  );
  const more = items.length - shown.length;
  const headlines = [
    ...parts.map((p) => `- ${p.headline}`),
    ...(more > 0
      ? [
          `- ${more} more session${more === 1 ? '' : 's'} need${more === 1 ? 's' : ''} attention; call fleet_sessions.`
        ]
      : [])
  ];
  const depth = ledger.extendChain(threadId);
  const last =
    depth >= FLEET_CHAIN_LIMIT
      ? [
          `This is the ${FLEET_CHAIN_LIMIT}th turn in a row Fleet has started for you since the user last wrote: sends and spawns are paused, and further updates are held, until they write.`
        ]
      : [];
  return {
    text: [headlines.join('\n'), ...parts.map((p) => p.detail), ...last].join('\n\n'),
    paused: depth >= FLEET_CHAIN_LIMIT
  };
}
