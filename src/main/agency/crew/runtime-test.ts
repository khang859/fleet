import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  RUNTIME_LABEL,
  type CrewRuntime,
  type RuntimeTestResult,
  type RuntimeTestRow
} from '../../../shared/agency-crew';
import type { HookEntry } from '../../claude-sessions/hook-installer';
import { testLaunch } from './runtimes';

/** The prompt of a test: one short answer, with no tool to run. */
export const TEST_PROMPT =
  'Fleet is testing that it can follow this runtime. Reply with the one word: ready.';

/** With no event by then, the runtime is held at a prompt or sends none. */
const FIRST_EVENT_MS = 45_000;
/** The longest a test waits for the turn to end. */
const TURN_MS = 120_000;

/** A hook event from a session in a pane, as the test needs it. */
export type TestEvent = {
  paneId: string;
  event: string;
  transcriptPath: string | null;
  error?: string;
};

export type RuntimeTestDeps = {
  /** Start a command in a terminal no pane shows; resolves to null once it runs, or why it did not. */
  spawn: (pane: {
    paneId: string;
    cwd: string;
    cmd: string;
    env: Record<string, string>;
  }) => Promise<string | null>;
  /** End it, and drop the session it ran. */
  kill: (paneId: string) => void;
  /** Hook events as they reach Fleet; returns the call that stops them. */
  subscribe: (listener: (event: TestEvent) => void) => () => void;
  /** Whether a file exists with something in it. */
  readable: (path: string) => Promise<boolean>;
  hooks: () => Record<string, HookEntry[]>;
  /** A folder for the files of a launch. */
  dir: string;
  now: () => number;
  newId: () => string;
  /** Unset in the app; tests make the waits short. */
  waits?: { firstEventMs: number; turnMs: number };
};

type Seen = { events: TestEvent[]; firstAt: number | null; ended: TestEvent | null };

/**
 * Collect the pane's events until its turn ends or the waits run out.
 * `cancel` ends it early, for a terminal that did not start.
 */
function follow(
  paneId: string,
  startedAt: number,
  deps: RuntimeTestDeps
): { seen: Promise<Seen>; cancel: () => void } {
  const waits = deps.waits ?? { firstEventMs: FIRST_EVENT_MS, turnMs: TURN_MS };
  const seen: Seen = { events: [], firstAt: null, ended: null };
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => (done = resolve));
  const stop = deps.subscribe((event) => {
    if (event.paneId !== paneId) return;
    seen.events.push(event);
    seen.firstAt ??= deps.now() - startedAt;
    if (event.event === 'Stop' || event.event === 'StopFailure') {
      seen.ended = event;
      done();
    }
  });
  const first = setTimeout(() => seen.firstAt === null && done(), waits.firstEventMs);
  const turn = setTimeout(done, waits.turnMs);
  const result = finished.then(() => {
    clearTimeout(first);
    clearTimeout(turn);
    stop();
    return seen;
  });
  return { seen: result, cancel: done };
}

/** Why nothing reached Fleet, for the first row. */
function silentReason(runtime: CrewRuntime, cwd: string): string {
  return runtime === 'claude'
    ? `No event came. Claude Code may be waiting at its folder trust prompt for ${cwd}, or for a sign-in.`
    : "No event came. eva sends events only through Fleet's hook in its config.toml.";
}

function rows(
  runtime: CrewRuntime,
  cwd: string,
  seen: Seen,
  transcript: boolean | null
): RuntimeTestRow[] {
  const label = RUNTIME_LABEL[runtime];
  const names = [...new Set(seen.events.map((e) => e.event))];
  const out: RuntimeTestRow[] = [
    {
      what: `${label} started in a hidden pane`,
      ok: true,
      detail:
        seen.firstAt === null
          ? 'Its terminal started'
          : `First event after ${(seen.firstAt / 1000).toFixed(1)}s`
    },
    {
      what: 'Hook events reach Fleet',
      ok: names.length > 0,
      detail: names.length > 0 ? names.join(', ') : silentReason(runtime, cwd)
    },
    {
      what: 'The turn ended',
      ok: seen.ended?.event === 'Stop',
      detail:
        seen.ended === null
          ? 'No Stop event'
          : seen.ended.event === 'Stop'
            ? 'Stop'
            : `Stopped on an error: ${seen.ended.error ?? 'unknown'}`
    }
  ];
  if (transcript !== null) {
    out.push({
      what: 'Transcript can be read',
      ok: transcript,
      detail: transcript ? 'JSONL' : 'Not reported, or not found'
    });
  }
  return out;
}

/**
 * Start a runtime as crew start it, in a terminal no pane shows, with a
 * prompt that needs one short answer, and report what reached Fleet: that it
 * started, its hook events, that its turn ended, and for Claude Code that
 * its transcript can be read. The terminal is ended after.
 */
export async function testRuntime(
  runtime: CrewRuntime,
  cwd: string,
  model: string | undefined,
  deps: RuntimeTestDeps
): Promise<RuntimeTestResult> {
  const paneId = deps.newId();
  const launch = testLaunch({
    runtime,
    sessionId: deps.newId(),
    dir: deps.dir,
    hooks: deps.hooks(),
    model,
    prompt: TEST_PROMPT
  });
  for (const file of launch.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.text);
  }
  const following = follow(paneId, deps.now(), deps);
  const error = await deps.spawn({ paneId, cwd, cmd: launch.cmd, env: launch.env });
  if (error !== null) {
    following.cancel();
    await following.seen;
    deps.kill(paneId);
    return { ok: false, reason: error };
  }
  const seen = await following.seen;
  deps.kill(paneId);
  const path = seen.events.find((e) => e.transcriptPath !== null)?.transcriptPath ?? null;
  const transcript = runtime === 'claude' ? path !== null && (await deps.readable(path)) : null;
  return { ok: true, rows: rows(runtime, cwd, seen, transcript) };
}
