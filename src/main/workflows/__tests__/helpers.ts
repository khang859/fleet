import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type {
  WorkflowAgentDef,
  WorkflowDef,
  WorkflowNotice,
  WorkflowRun
} from '../../../shared/workflows';
import type { WorkflowsBridge } from '../bridge-routes';
import { WorkflowRunManager, type RunDeps, type RunPlan } from '../run-manager';
import { RunStore } from '../run-store';

/** Let the work behind a `void` promise run. The clock in these tests is fake, this is not. */
export async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

export type Answer = { status: number; body: unknown };

export function fakeRes(): { res: ServerResponse; answer: Promise<Answer> } {
  let status = 0;
  let resolve: (answer: Answer) => void = () => undefined;
  const answer = new Promise<Answer>((done) => {
    resolve = done;
  });
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(body?: string) {
      resolve({ status, body: body === undefined ? undefined : JSON.parse(body) });
    }
  };
  return { res: res as unknown as ServerResponse, answer };
}

export function fakeReq(body: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new PassThrough();
  req.end(body);
  return Object.assign(req, { headers }) as unknown as IncomingMessage;
}

/** POST to a bridge route, the way a pane's extension does. */
export async function postTo(
  bridge: WorkflowsBridge,
  route: string,
  body: unknown
): Promise<Answer> {
  const { res, answer } = fakeRes();
  const url = new URL(`http://fleet${route}`);
  bridge.routes()[`POST ${route}`].handle(fakeReq(JSON.stringify(body)), res, url);
  return answer;
}

export function agentDef(role: string, program: 'pi' | 'claude' = 'pi'): WorkflowAgentDef {
  return { role, program, prompt: `Do the ${role} work.` };
}

export function makeDef(overrides: Partial<WorkflowDef> = {}): WorkflowDef {
  return {
    name: 'Review',
    shared: 'Be careful.',
    board: true,
    workspace: 'current',
    inputs: [],
    agents: [agentDef('First'), agentDef('Second')],
    ...overrides
  };
}

export function makeRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: 'run-1',
    workflowId: 'review',
    workflowName: 'Review',
    workflowPath: '/repo/.fleet/workflows/review.toml',
    projectPath: '/repo',
    hash: 'hash',
    inputs: {},
    target: '[]',
    slug: 'review',
    origin: 'manual',
    ruleId: null,
    state: 'running',
    createdAt: 0,
    endedAt: null,
    cwd: '/repo',
    worktreePath: null,
    pr: null,
    locked: false,
    problem: null,
    usesBoard: true,
    finish: null,
    agents: [],
    board: [],
    report: null,
    activeMs: 0,
    limitMs: 1000,
    limitReachedAt: null,
    sleptMs: 0,
    keptPanes: [],
    teamPr: false,
    ...overrides
  };
}

export function makePlan(def: WorkflowDef, overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    workflowId: 'review',
    path: '/repo/.fleet/workflows/review.toml',
    projectPath: '/repo',
    def,
    bytes: 'name = "Review"',
    hash: 'hash',
    inputs: {},
    target: '[]',
    slug: 'review',
    origin: 'manual',
    ruleId: null,
    pr: null,
    locked: false,
    teamPr: false,
    focus: true,
    ...overrides
  };
}

export const SAMPLE_PR = {
  number: 7,
  title: 'Fix it',
  url: 'https://github.com/acme/app/pull/7',
  headSha: 'old-sha',
  movedOn: false
};

export const SAMPLE_ISSUE = {
  number: 9,
  title: 'It breaks',
  url: 'https://github.com/acme/app/issues/9',
  state: 'open'
};

/** Where the fake clock starts. */
export const START_TIME = 1_000_000;

/** The ticks that real time would give. Each one is under the sleep gap. */
const TICK_STEP_MS = 30_000;

export type Harness = {
  deps: RunDeps;
  manager: WorkflowRunManager;
  clock: { now: number };
  opened: Array<{ paneId: string; cwd: string; line: string }>;
  killed: string[];
  notices: Array<Omit<WorkflowNotice, 'id'>>;
  ended: WorkflowRun[];
  advance: (ms: number) => Promise<void>;
  /** The same store, as a new launch of Fleet sees it. */
  relaunch: () => WorkflowRunManager;
};

/** A run manager with every outside thing faked, and a real store in `dir`. */
export function makeHarness(dir: string, overrides: Partial<RunDeps> = {}): Harness {
  const clock = { now: START_TIME };
  const opened: Harness['opened'] = [];
  const killed: string[] = [];
  const notices: Harness['notices'] = [];
  const ended: WorkflowRun[] = [];

  const deps: RunDeps = {
    store: new RunStore(join(dir, 'runs')),
    now: () => clock.now,
    openPane: async (pane) => {
      opened.push(pane);
      return Promise.resolve();
    },
    killPane: (paneId) => {
      killed.push(paneId);
    },
    lastOutputAt: () => clock.now,
    sendPrompt: async () => Promise.resolve(true),
    makeWorktree: async () => Promise.resolve({ path: '/worktrees/run', sha: 'new-sha' }),
    removeWorktree: async () => Promise.resolve(undefined),
    onRun: () => undefined,
    onTab: () => undefined,
    notify: (notice) => {
      notices.push(notice);
    },
    onEnded: (run) => {
      ended.push(run);
    },
    makeBranch: async () =>
      Promise.resolve({
        path: '/worktrees/branch',
        branch: { name: 'fleet/review', base: 'main', baseSha: 'base-sha' }
      }),
    diffOf: async () => Promise.resolve('diff --git a b'),
    answerRequest: () => true,
    maxAgents: () => 12,
    devExtension: null,
    parse: () => makeDef(),
    ...overrides
  };

  const harness: Harness = {
    deps,
    manager: new WorkflowRunManager(deps),
    clock,
    opened,
    killed,
    notices,
    ended,
    advance: async (ms) => {
      for (let left = ms; left > 0; left -= TICK_STEP_MS) {
        clock.now += Math.min(left, TICK_STEP_MS);
        harness.manager.tick();
      }
      await flush();
    },
    relaunch: () => new WorkflowRunManager({ ...deps, store: new RunStore(join(dir, 'runs')) })
  };
  return harness;
}

/** Create a run and wait until its panes are open. */
export async function startRun(harness: Harness, plan: RunPlan): Promise<WorkflowRun> {
  const run = harness.manager.create(plan);
  await flush();
  return run;
}

/** The pane of an agent, for a test that knows the agent has one. */
export function paneOf(run: WorkflowRun, index: number): string {
  const { paneId } = run.agents[index];
  if (paneId === null) throw new Error(`Agent ${index} has no pane.`);
  return paneId;
}

/** Each agent with a pane reports that its session is up. */
export function sessionsUp(harness: Harness, run: WorkflowRun): void {
  for (const agent of run.agents) {
    if (agent.paneId === null) continue;
    harness.manager.onSessionStart(agent.paneId, {
      id: `session-${agent.role}`,
      transcriptPath: `/transcripts/${agent.role}.jsonl`
    });
  }
}
