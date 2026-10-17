import { create } from 'zustand';
import type {
  AgencyChanged,
  AgencyRepoRef,
  AgencySnapshot,
  WakeupPull
} from '../../../shared/agency';
import { jobDisplayId } from '../../../shared/agency';
import type { AgentMessage } from '../../../shared/agent-types';
import { textMessage } from '../../../shared/agent-types';
import type { ActivityState } from '../../../shared/types';
import { admiralKey, parseAdmiralKey } from './admiral-thread';
import { canDeliverTo, startUnpromptedTurn } from './agent-schedule';
import {
  flushQueued,
  publishActivity,
  record,
  registerAdmiralHooks,
  useAgentStore,
  type PaneThread
} from './agent-store';
import { findJob, openQuestions, useAgencyStore } from './agency-store';
import { useSettingsStore } from './settings-store';
import { collectPaneLeafs, isAdmiralLeaf, useWorkspaceStore } from './workspace-store';
import { createLogger } from '../logger';

const log = createLogger('store:admiral-runtime');

/**
 * The renderer half of the Admiral: everything about an Admiral pane that is
 * not drawing it.
 *
 * Main owns the jobs, the questions and the wakeups; the agent store owns each
 * conversation's transcript. This joins them up for every Admiral pane in the
 * layout, in the current workspace or a background one: it claims the
 * repository, opens the lobby and one conversation per job, hands a job the
 * lobby talk that led to it, turns due wakeups into turns, and works out what
 * the pane as a whole is doing for the badge.
 *
 * A store subscription rather than a component effect, because a pane in a
 * background workspace still has wakeups to take and a badge to keep.
 */

/** How an Admiral pane's attach went, for the pane to draw. */
export type AdmiralPaneStatus =
  | { kind: 'attaching' }
  | { kind: 'ready'; lobbySessionId: string }
  | { kind: 'refused'; ownerPaneId: string }
  | { kind: 'failed'; message: string };

type AdmiralRuntimeState = { panes: Partial<Record<string, AdmiralPaneStatus>> };

export const useAdmiralRuntimeStore = create<AdmiralRuntimeState>(() => ({ panes: {} }));

type Attached = { paneId: string; repo: AgencyRepoRef; lobbySessionId: string };

/** Panes attached and ready, by pane id. */
const attached = new Map<string, Attached>();
/** Each pane's current attach, so one that a detach or a newer attach overtook stops. */
const attaching = new Map<string, number>();
let attachTicket = 0;

/** The wakeups each running turn was started with, by stream id: settled when it ends. */
const inFlight = new Map<string, { key: string; ids: number[] }>();
/** Wakeups pulled for a thread that was busy by the time they arrived, by thread key. */
const held = new Map<string, { ids: number[]; text: string }>();
/** Threads with a pull in flight, so a burst of changes makes one round trip. */
const pulling = new Set<string>();
/** When each thread next has a wakeup coming due, as a timer that checks it then. */
const timers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>();
/** Jobs whose handoff is waiting for the lobby to be free, by pane. */
const pendingHandoffs = new Map<string, Map<number, boolean>>();
/** Jobs with a handoff under way. */
const handingOff = new Set<number>();

function setStatus(paneId: string, status: AdmiralPaneStatus | null): void {
  useAdmiralRuntimeStore.setState((s) => {
    const panes = { ...s.panes };
    if (status === null) delete panes[paneId];
    else panes[paneId] = status;
    return { panes };
  });
}

function thread(key: string): PaneThread | undefined {
  return useAgentStore.getState().threads[key];
}

/** Every thread key an attached pane has open: its lobby and its jobs. */
function keysOf(paneId: string): string[] {
  return Object.keys(useAgentStore.getState().threads).filter(
    (key) => parseAdmiralKey(key)?.paneId === paneId
  );
}

function attachedFor(repoId: string): Attached[] {
  return [...attached.values()].filter((a) => a.repo.repoId === repoId);
}

/**
 * Attach an Admiral pane: claim its repository, read the agency state, and
 * open its lobby and every open job's conversation. Safe to call again for a
 * pane already attached.
 */
export async function attachAdmiral(paneId: string, repo: AgencyRepoRef): Promise<void> {
  if (attached.get(paneId)?.repo.repoId === repo.repoId) return;
  const ticket = ++attachTicket;
  attaching.set(paneId, ticket);
  const current = (): boolean => attaching.get(paneId) === ticket;
  setStatus(paneId, { kind: 'attaching' });

  try {
    const claim = await window.fleet.agency.claimAdmiral({ repoId: repo.repoId, paneId });
    if (!current()) return;
    if (!claim.ok) {
      setStatus(paneId, { kind: 'refused', ownerPaneId: claim.ownerPaneId });
      return;
    }
    const lobbySessionId = await window.fleet.agency.ensureLobby(repo);
    const snapshot = await useAgencyStore.getState().refresh(repo.repoId);
    if (!current()) return;
    if (snapshot === null) throw new Error('could not read the agency state');

    attached.set(paneId, { paneId, repo, lobbySessionId });
    await openThreads(paneId, snapshot);
    if (!current()) return;
    attaching.delete(paneId);
    setStatus(paneId, { kind: 'ready', lobbySessionId });

    // A handoff the app quit in the middle of.
    for (const job of snapshot.jobs) {
      if (!job.handoffDone) requestHandoff(paneId, job.id, false);
    }
    rollUp(paneId);
    for (const key of keysOf(paneId)) check(key);
  } catch (err) {
    if (!current()) return;
    attaching.delete(paneId);
    attached.delete(paneId);
    log.warn('attach failed', { paneId, error: String(err) });
    setStatus(paneId, { kind: 'failed', message: String(err) });
  }
}

/**
 * Stop looking after a pane: it closed, or the agency was turned off. Its
 * transcripts are the agent store's to drop; its claim is the layout's to give
 * up. Wakeups it had pulled and not delivered go back to main on the next
 * start, when a stale claim is released.
 */
export function detachAdmiral(paneId: string): void {
  attaching.delete(paneId);
  attached.delete(paneId);
  pendingHandoffs.delete(paneId);
  for (const key of [...held.keys(), ...timers.keys(), ...pulling]) {
    if (parseAdmiralKey(key)?.paneId !== paneId) continue;
    held.delete(key);
    pulling.delete(key);
    const timer = timers.get(key);
    if (timer !== undefined) clearTimeout(timer.timer);
    timers.delete(key);
  }
  setStatus(paneId, null);
}

/** Open the lobby and every job conversation not yet open, and note each job's session on the leaf. */
async function openThreads(paneId: string, snapshot: AgencySnapshot): Promise<void> {
  const pane = attached.get(paneId);
  if (pane === undefined) return;
  const store = useAgentStore.getState();
  const opening = [
    store.openSession(admiralKey(paneId, null), pane.lobbySessionId, pane.repo.root)
  ];
  for (const job of snapshot.jobs) {
    opening.push(store.openSession(admiralKey(paneId, job.id), job.sessionId, pane.repo.root));
    useWorkspaceStore.getState().setAdmiralJobSession(paneId, job.id, job.sessionId);
  }
  await Promise.all(opening);
}

/** Main changed something about a repository. */
async function onChanged(change: AgencyChanged): Promise<void> {
  const panes = attachedFor(change.repoId);
  if (panes.length === 0) return;
  const snapshot = await useAgencyStore.getState().refresh(change.repoId);
  if (snapshot === null) return;
  for (const pane of panes) {
    if (attached.get(pane.paneId) !== pane) continue;
    await openThreads(pane.paneId, snapshot);
    if (change.openedJobId !== undefined) requestHandoff(pane.paneId, change.openedJobId, true);
    for (const jobId of change.jobIds) check(admiralKey(pane.paneId, jobId));
  }
}

/**
 * Collect what is due for one thread, if it is free to take it.
 *
 * The client goes first: anything they queued during the last turn is sent
 * before a wakeup is even asked for. A busy thread does nothing, and the pull
 * is main's one consume path, so calls racing cannot deliver a wakeup twice.
 */
export function check(key: string): void {
  const scope = parseAdmiralKey(key);
  const pane = scope === null ? undefined : attached.get(scope.paneId);
  const current = thread(key);
  if (scope === null || pane === undefined || current === undefined || !canDeliverTo(current)) {
    return;
  }
  if (flushQueued(key)) return;

  const waiting = held.get(key);
  if (waiting !== undefined) {
    held.delete(key);
    deliver(key, waiting.ids, waiting.text);
    return;
  }

  if (pulling.has(key)) return;
  pulling.add(key);
  void window.fleet.agency
    .pullWakeups({ repoId: pane.repo.repoId, jobId: scope.jobId })
    .then((pull: WakeupPull) => {
      if (attached.get(scope.paneId) !== pane) return;
      if (pull.ids.length > 0) deliver(key, pull.ids, pull.text ?? '');
      retryAt(key, pull.nextDueAt);
    })
    .catch((err: unknown) => {
      log.warn('wakeup pull failed', { key, error: String(err) });
    })
    .finally(() => {
      pulling.delete(key);
    });
}

/**
 * Start a turn from a batch of wakeups, or hold it for when the thread is
 * free. The batch is recorded as the turn's opening message before the turn
 * runs, and only acknowledged once the turn has ended without failing.
 */
function deliver(key: string, ids: number[], text: string): void {
  const current = thread(key);
  const queued = current?.messages.some((m) => m.meta?.kind === 'queued') ?? false;
  if (current === undefined || !canDeliverTo(current) || queued) {
    const before = held.get(key);
    held.set(key, {
      ids: [...(before?.ids ?? []), ...ids],
      text: before === undefined ? text : `${before.text}\n\n${text}`
    });
    return;
  }
  const event: AgentMessage = {
    ...textMessage(crypto.randomUUID(), 'fleet', text),
    meta: { kind: 'event' }
  };
  const streamId = startUnpromptedTurn(key, current, [event]);
  if (streamId === null) {
    held.set(key, { ids, text });
    return;
  }
  inFlight.set(streamId, { key, ids });
  log.debug('delivered wakeups', { key, count: ids.length });
}

/** Check a thread again when its next wakeup comes due, keeping the earliest time asked for. */
function retryAt(key: string, at: number | null): void {
  if (at === null) return;
  const existing = timers.get(key);
  if (existing !== undefined && existing.at <= at) return;
  if (existing !== undefined) clearTimeout(existing.timer);
  const timer = setTimeout(
    () => {
      timers.delete(key);
      check(key);
    },
    Math.max(0, at - Date.now())
  );
  timers.set(key, { at, timer });
}

/**
 * A turn on an Admiral thread ended. Its wakeups are acknowledged when it
 * finished - a cancel included, since the client chose to stop it - and handed
 * back to retry after a backoff when it failed. Then a handoff waiting on the
 * lobby, then whatever is next for the thread.
 */
function turnEnded(key: string, streamId: string, error: string | null): void {
  const wakeups = inFlight.get(streamId);
  if (wakeups !== undefined) {
    inFlight.delete(streamId);
    if (error === null) {
      window.fleet.agency.ackWakeups(wakeups.ids).catch((err: unknown) => {
        log.warn('wakeup ack failed', { key, error: String(err) });
      });
    } else {
      void window.fleet.agency
        .releaseWakeups({ ids: wakeups.ids, error })
        .then((release) => retryAt(key, release.nextDueAt))
        .catch((err: unknown) => {
          log.warn('wakeup release failed', { key, error: String(err) });
        });
    }
  }
  const scope = parseAdmiralKey(key);
  if (scope?.jobId === null) runPendingHandoffs(scope.paneId);
  check(key);
}

/** Hand a job the lobby talk that led to it, now or once the lobby is free. */
function requestHandoff(paneId: string, jobId: number, show: boolean): void {
  const pending = pendingHandoffs.get(paneId) ?? new Map<number, boolean>();
  pending.set(jobId, (pending.get(jobId) ?? false) || show);
  pendingHandoffs.set(paneId, pending);
  runPendingHandoffs(paneId);
}

function runPendingHandoffs(paneId: string): void {
  const lobby = thread(admiralKey(paneId, null));
  const pending = pendingHandoffs.get(paneId);
  if (lobby === undefined || pending === undefined || !canDeliverTo(lobby)) return;
  pendingHandoffs.delete(paneId);
  for (const [jobId, show] of pending) void handoff(paneId, jobId, show);
}

/**
 * Carry the lobby conversation over into a job just opened from it.
 *
 * Idempotent at every step, because it runs again after a restart for a job
 * whose handoff never finished: a job conversation that already has messages
 * is not seeded twice, and a lobby that already links the job is not linked
 * twice. Run only while the lobby is free, so the turn that opened the job has
 * said its last word and it is carried over too.
 */
export async function handoff(paneId: string, jobId: number, show: boolean): Promise<void> {
  const pane = attached.get(paneId);
  if (pane === undefined || handingOff.has(jobId)) return;
  const job = findJob(useAgencyStore.getState().snapshots[pane.repo.repoId], jobId);
  if (job === null) return;
  handingOff.add(jobId);
  try {
    const jobKey = admiralKey(paneId, jobId);
    const lobbyKey = admiralKey(paneId, null);
    await useAgentStore.getState().openSession(jobKey, job.sessionId, pane.repo.root);
    useWorkspaceStore.getState().setAdmiralJobSession(paneId, jobId, job.sessionId);
    if (attached.get(paneId) !== pane) return;

    if (!job.handoffDone) {
      const lobby = thread(lobbyKey);
      const target = thread(jobKey);
      if (lobby === undefined || target === undefined) return;
      if (target.messages.length === 0) seed(jobKey, target, lobby);
      const link = linkJob(lobbyKey, lobby, jobId, job.title);
      await window.fleet.agency.markHandoff({ jobId, lobbyMessageId: link });
    }
    if (show) useWorkspaceStore.getState().setAdmiralActiveJob(paneId, jobId);
  } catch (err) {
    log.warn('handoff failed', { paneId, jobId, error: String(err) });
  } finally {
    handingOff.delete(jobId);
  }
}

/**
 * Put the lobby talk since the last job it opened at the start of a job's
 * conversation, and write it to the job's log.
 */
function seed(jobKey: string, target: PaneThread, lobby: PaneThread): void {
  const lastLink = lobby.messages.findLastIndex((m) => m.meta?.kind === 'job-link');
  const carried = lobby.messages
    .slice(lastLink + 1)
    .filter((m) => m.meta?.kind !== 'queued' && m.id !== lobby.streamId);
  if (carried.length === 0) return;
  useAgentStore.setState((s) => {
    const now = s.threads[jobKey] ?? target;
    return {
      threads: { ...s.threads, [jobKey]: { ...now, messages: [...carried, ...now.messages] } }
    };
  });
  for (const message of carried) record(target, { t: 'message', message });
}

/** The lobby's line saying a job was opened from it. Resolves the line's id. */
function linkJob(lobbyKey: string, lobby: PaneThread, jobId: number, title: string): string {
  const existing = lobby.messages.find(
    (m) => m.meta?.kind === 'job-link' && m.meta.jobId === jobId
  );
  if (existing !== undefined) return existing.id;
  const link: AgentMessage = {
    ...textMessage(crypto.randomUUID(), 'fleet', `${jobDisplayId(jobId)}: ${title} - opened`),
    meta: { kind: 'job-link', jobId }
  };
  useAgentStore.setState((s) => {
    const now = s.threads[lobbyKey] ?? lobby;
    // Before a turn that started since, so the link sits where the job left.
    const at = now.streamId === null ? -1 : now.messages.findIndex((m) => m.id === now.streamId);
    const messages =
      at === -1
        ? [...now.messages, link]
        : [...now.messages.slice(0, at), link, ...now.messages.slice(at)];
    return { threads: { ...s.threads, [lobbyKey]: { ...now, messages } } };
  });
  record(lobby, { t: 'message', message: link });
  return link.id;
}

/**
 * What an Admiral pane is doing, across all its conversations and its
 * questions: a question waiting on the client needs them, wherever it was
 * asked; otherwise it is working while any conversation has a turn running.
 */
export function rollUpState(paneId: string): ActivityState {
  const pane = attached.get(paneId);
  if (pane === undefined) return 'idle';
  const snapshot = useAgencyStore.getState().snapshots[pane.repo.repoId];
  const keys = keysOf(paneId);
  const asking =
    openQuestions(snapshot).length > 0 ||
    keys.some((key) => thread(key)?.pendingPermission != null);
  if (asking) return 'needs_me';
  return keys.some((key) => thread(key)?.streamId != null) ? 'working' : 'idle';
}

function rollUp(paneId: string): void {
  const pane = attached.get(paneId);
  if (pane === undefined) return;
  publishActivity(paneId, rollUpState(paneId), pane.repo.name);
}

/** The Admiral leaves in every open workspace, with their repositories. */
function admiralLeaves(): Map<string, AgencyRepoRef> {
  const state = useWorkspaceStore.getState();
  const leaves = new Map<string, AgencyRepoRef>();
  for (const ws of [state.workspace, ...state.backgroundWorkspaces.values()]) {
    for (const tab of ws.tabs) {
      for (const leaf of collectPaneLeafs(tab.splitRoot)) {
        if (isAdmiralLeaf(leaf) && leaf.admiralRepo) leaves.set(leaf.id, leaf.admiralRepo);
      }
    }
  }
  return leaves;
}

/**
 * Start looking after every Admiral pane, and keep doing so as panes open and
 * close and the agency is turned on and off. Returns the stop function.
 */
export function initAdmiralRuntime(): () => void {
  const offHooks = registerAdmiralHooks({
    scope: (key) => {
      const scope = parseAdmiralKey(key);
      const pane = scope === null ? undefined : attached.get(scope.paneId);
      return scope === null || pane === undefined
        ? null
        : { repoId: pane.repo.repoId, jobId: scope.jobId };
    },
    rollUp,
    turnEnded
  });

  let signature = '';
  const sync = (): void => {
    const enabled = useSettingsStore.getState().settings?.agency.enabled === true;
    const leaves = enabled ? admiralLeaves() : new Map<string, AgencyRepoRef>();
    const next = [...leaves].map(([id, repo]) => `${id}=${repo.repoId}`).join(',');
    if (next === signature) return;
    signature = next;
    for (const paneId of new Set([...attached.keys(), ...attaching.keys()])) {
      if (!leaves.has(paneId)) detachAdmiral(paneId);
    }
    for (const [paneId, repo] of leaves) void attachAdmiral(paneId, repo);
  };
  sync();
  const offWorkspace = useWorkspaceStore.subscribe(sync);
  const offSettings = useSettingsStore.subscribe(sync);

  // A question asked or answered changes the badge without any turn moving.
  const offAgency = useAgencyStore.subscribe((s, prev) => {
    if (s.snapshots === prev.snapshots) return;
    for (const pane of attached.values()) {
      if (s.snapshots[pane.repo.repoId] !== prev.snapshots[pane.repo.repoId]) rollUp(pane.paneId);
    }
  });

  const offChanged = window.fleet.agency.onChanged((change) => {
    void onChanged(change);
  });

  return () => {
    offHooks();
    offWorkspace();
    offSettings();
    offAgency();
    offChanged();
    for (const paneId of [...attached.keys(), ...attaching.keys()]) detachAdmiral(paneId);
    inFlight.clear();
    handingOff.clear();
  };
}
