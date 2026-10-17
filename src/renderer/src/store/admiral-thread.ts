import type { AgentTurnMode } from '../../../shared/agent-types';
import type { FleetSettings } from '../../../shared/types';

/**
 * Agent-store thread keys for an Admiral pane's conversations.
 *
 * An Agent pane has one thread, keyed by its pane id. An Admiral pane has a
 * lobby and one thread per job, so its keys carry the pane and the job:
 * `admiral:<paneId>:lobby` and `admiral:<paneId>:j<N>`. Everything keyed by
 * pane elsewhere (activity, badges, focus) maps a key back with `ownerPane`.
 */

const PREFIX = 'admiral:';

/** The thread key for an Admiral pane's lobby (`jobId` null) or one of its jobs. */
export function admiralKey(paneId: string, jobId: number | null): string {
  return `${PREFIX}${paneId}:${jobId === null ? 'lobby' : `j${jobId}`}`;
}

/** The pane and job a key names, or null for a key that is not an Admiral's. */
export function parseAdmiralKey(key: string): { paneId: string; jobId: number | null } | null {
  if (!key.startsWith(PREFIX)) return null;
  const rest = key.slice(PREFIX.length);
  // The pane id comes first and may itself hold colons, so the job is read
  // from the end.
  const split = rest.lastIndexOf(':');
  if (split <= 0) return null;
  const paneId = rest.slice(0, split);
  const job = rest.slice(split + 1);
  if (job === 'lobby') return { paneId, jobId: null };
  const match = /^j([1-9]\d*)$/.exec(job);
  return match ? { paneId, jobId: Number(match[1]) } : null;
}

export function isAdmiralKey(key: string): boolean {
  return parseAdmiralKey(key) !== null;
}

/** The pane a thread key belongs to: itself for an Agent pane. */
export function ownerPane(key: string): string {
  return parseAdmiralKey(key)?.paneId ?? key;
}

/**
 * The engine mode a thread's turns run in. An Admiral key is always an
 * Admiral turn; any other thread is the Agent pane's own, orchestrating or not.
 */
export function turnModeFor(key: string, orchestrator: boolean): AgentTurnMode {
  if (isAdmiralKey(key)) return 'admiral';
  return orchestrator ? 'orchestrator' : 'chat';
}

/**
 * The model a thread's turns run on. An Admiral runs on its own model when one
 * is set and on the Agent's coding model otherwise; everything else on the
 * coding model. Empty when none is chosen.
 */
export function threadModelId(key: string, settings: Pick<FleetSettings, 'agency' | 'ai'>): string {
  const coding = settings.ai.agent.coding.model ?? '';
  return isAdmiralKey(key) ? settings.agency.admiral.model || coding : coding;
}
