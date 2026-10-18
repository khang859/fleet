import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DEFAULT_AGENCY_SETTINGS, type AgencyRepoRef } from '../../../../shared/agency';
import { PlanSchema, PlanStepSchema, type PlanInput } from '../../../../shared/agency-plan';
import type { AgentAgencyCapability } from '../../../../shared/agency-tools';
import { AgencyService } from '../../index';
import { crewAtOnce } from '../../__tests__/fixture';
import { fakeGh, initRepo, tempDir } from '../../projects/__tests__/git-fixture';
import { createAgencyCapability } from '../../tools';
import { PROMPT_MISMATCH, type SendResult } from '../../../claude-sessions/input';
import { NEEDS_YOU_MS, STUCK_MS, type CrewSessionState } from '../crew-flags';
import { stepBrief, type CrewPaneHost, type CrewPaneOpen } from '../crew-service';

/**
 * Hiring crew on a real repository, with Fleet's panes faked: what opens,
 * what is typed, and how a step moves as its crew member comes and goes.
 */

let home: { dir: string; cleanup: () => void };
let service: AgencyService;
let panes: FakePanes;
let ref: AgencyRepoRef;

type FakePanes = CrewPaneHost & {
  opened: CrewPaneOpen[];
  written: Array<[string, string]>;
  killed: string[];
  sent: Array<[string, string]>;
  running: Set<string>;
  openError: string | null;
  sendResult: SendResult | null;
  screens: Map<string, string>;
  sessions: Map<string, CrewSessionState>;
};

function fakePanes(): FakePanes {
  const host: FakePanes = {
    opened: [],
    written: [],
    killed: [],
    sent: [],
    running: new Set(),
    openError: null,
    sendResult: null,
    screens: new Map(),
    sessions: new Map(),
    open: async (pane) => {
      if (host.openError !== null) return Promise.resolve(host.openError);
      host.opened.push(pane);
      host.running.add(pane.paneId);
      return Promise.resolve(null);
    },
    write: (paneId, data) => void host.written.push([paneId, data]),
    kill: (paneId) => {
      host.killed.push(paneId);
      host.running.delete(paneId);
    },
    live: () => host.running,
    notePaneInput: () => {},
    prompter: {
      refusal: () => null,
      send: async (sessionId, text) => {
        host.sent.push([sessionId, text]);
        return Promise.resolve(host.sendResult ?? { ok: true, text, confirmed: true });
      }
    },
    hooks: () => ({}),
    screen: async (paneId) => Promise.resolve(host.screens.get(paneId) ?? null),
    session: (sessionId) => host.sessions.get(sessionId)
  };
  return host;
}

let ids = 0;
let clock = 1_000_000;

function start(crewLimit = 4): void {
  service = new AgencyService({
    dbPath: join(home.dir, 'agency.db'),
    emit: () => {},
    hasModelKey: () => true,
    gh: fakeGh(() => ({ code: 0, stdout: '' })),
    agencyHome: join(home.dir, 'agency-home'),
    crewDirs: { bundled: join(process.cwd(), 'resources', 'crew'), user: null },
    crewPanes: panes,
    agencySettings: crewAtOnce(crewLimit),
    now: () => clock,
    // Pane and session ids, in a known order.
    newCrewId: () => {
      ids += 1;
      return `id-${String(ids).padStart(4, '0')}-0000-0000-000000000000`;
    }
  });
}

beforeEach(async () => {
  home = tempDir('fleet-crew-');
  panes = fakePanes();
  ids = 0;
  clock = 1_000_000;
  start();
  const root = initRepo(join(home.dir, 'solo'), { 'a.txt': 'a' });
  const res = await service.resolveRepo(root);
  if (!res.ok) throw new Error('not a repo');
  ref = { repoId: res.repoId, root, name: res.name };
  service.ensureLobby(ref);
});

afterEach(() => {
  service.close();
  home.cleanup();
});

const step = (id: string, over: Partial<PlanInput['steps'][number]> = {}) => ({
  id,
  role: 'builder',
  title: `Build ${id}`,
  deliverables: ['branch' as const],
  ...over
});

const toolsOf = (jobId: number | null): AgentAgencyCapability =>
  createAgencyCapability(service, { repoId: ref.repoId, jobId }, () => ({
    ...DEFAULT_AGENCY_SETTINGS,
    enabled: true
  }));

async function approvedJob(steps = [step('front')]): Promise<number> {
  const job = service.openJob({
    repoId: ref.repoId,
    title: 'Dark mode',
    brief: 'b',
    budgetUsd: null
  });
  const plan = PlanSchema.parse({ playbook: 'feature', summary: 's', steps, budget: { usd: 5 } });
  const out = await toolsOf(job.id).jobPlan!(plan);
  const id = Number(/plan#(\d+)/.exec(out.summary)?.[1]);
  const decided = await service.jobs.decide({ planVersionId: id, action: 'approve' });
  if (!decided.ok) throw new Error(decided.reason);
  return job.id;
}

const stepStatus = (jobId: number, id: string): string | undefined =>
  service.store.plans.step(jobId, id)?.status;

const crewOf = (jobId: number) => service.jobs.detail(jobId)?.crew ?? [];

describe('stepBrief', () => {
  const step = (over: Partial<PlanInput['steps'][number]> = {}) =>
    PlanStepSchema.parse({ id: 'web', role: 'builder', title: 'Web', ...over });

  it('passes a plain step brief as it is', () => {
    expect(stepBrief(step(), 'Build it.')).toBe('Build it.');
  });

  it('tells a scoped member its part, and a reader to change nothing', () => {
    expect(stepBrief(step({ scope: 'the web UI' }), 'Build it.')).toBe(
      'Build it.\n\nYour scope is the web UI. Change only that part: other crew members own the rest.'
    );
    expect(stepBrief(step({ workspace: { of: 'api' } }), 'Review it.')).toBe(
      "Review it.\n\nThis worktree is step api's. Read and run it, but change and commit nothing."
    );
  });

  it('names what the step hands back, and where a reader writes its files', () => {
    const deliverables = [
      { kind: 'review' as const },
      { kind: 'branch' as const, label: 'The fix' }
    ];
    expect(stepBrief(step({ deliverables }), 'Fix it.')).toBe(
      'Fix it.\n\nThis step hands back: Review notes (review), The fix (branch). Pass each file to `fleet agency done` with `--deliver <path>`.'
    );
    expect(stepBrief(step({ deliverables: ['link'] }), 'Find it.')).toBe(
      'Find it.\n\nThis step hands back: Link (link).'
    );
    const reader = step({ workspace: { of: 'fix' }, deliverables: ['review'] });
    expect(stepBrief(reader, 'Review it.', { handback: '/jobs/1/handback/web' })).toContain(
      'This step hands back: Review notes (review). Write each file it hands back in /jobs/1/handback/web. Pass each file to `fleet agency done` with `--deliver <path>`.'
    );
  });

  it('names the members checked out for a writer, and says not to update them', () => {
    const members = [
      { member: 'core', path: 'libs/core', branch: 'admiral/j1/web-1' },
      { member: 'api', path: 'libs/api', branch: 'admiral/j1/web-1' }
    ];
    expect(stepBrief(step(), 'Build it.', { members })).toBe(
      'Build it.\n\nFleet checked out libs/core (core), libs/api (api) for you, on the branch admiral/j1/web-1. Commit in each one as it is. Do not run `git submodule update` or switch branches in them: that moves them off the branch. Other members are not checked out, because this step does not change them.'
    );
    expect(stepBrief(step({ workspace: { of: 'api' } }), 'Review it.', { members })).not.toContain(
      'checked out'
    );
  });

  it('names the skills the step uses', () => {
    expect(stepBrief(step({ skills: ['journey-qa-sweep'] }), 'Test it.')).toBe(
      'Test it.\n\nUse the skill journey-qa-sweep for this work.'
    );
    expect(stepBrief(step({ skills: ['lint', 'sweep'] }), 'Test it.')).toContain(
      'Use the skills lint, sweep for this work.'
    );
  });

  it('gives the port each server variable is set to, and the block for any other server', () => {
    const env = {
      API_PORT: '41000',
      WEB_PORT: '41001',
      FLEET_PORTS: '41000-41019',
      COMPOSE_PROJECT_NAME: 'admiral-j1-web-1'
    };
    expect(stepBrief(step(), 'Build it.', { env })).toBe(
      "Build it.\n\nYour env sets the servers' ports: API_PORT=41000, WEB_PORT=41001. Use them, never the defaults: other jobs run servers too. For any other server, pick a free port in 41000-41019 (FLEET_PORTS)."
    );
  });
});

describe('crew_hire', () => {
  it('opens the role on its runtime in a new worktree, as a pane of the job tab', async () => {
    const jobId = await approvedJob();
    const out = await toolsOf(jobId).crewHire!({ step: 'front', brief: '- Build the toggle.' });

    expect(out.summary).toBe('hired builder 1');
    const [pane] = panes.opened;
    expect(pane).toMatchObject({
      label: 'builder 1',
      job: { jobId, label: 'j1 Dark mode' },
      cwd: join(home.dir, 'agency-home', 'jobs', '1', 'ws', 'front-1')
    });
    const block = pane.launch.env.FLEET_PORTS;
    expect(block).toMatch(/^\d+-\d+$/);
    expect(pane.launch.env.COMPOSE_PROJECT_NAME).toBe('admiral-j1-front-1');
    expect(pane.prompt).toBe(
      `[admiral] - Build the toggle.\n\nThis step hands back: Local branch (branch).\n\nOther jobs run servers too, so never use a default port. For any other server, pick a free port in ${block} (FLEET_PORTS).`
    );
    expect(pane.launch.exitOnComplete).toBe(true);
    expect(pane.launch.cmd).toMatch(/^claude --session-id "\$FLEET_CREW_SESSION_ID" /);
    expect(pane.launch.env.FLEET_CREW_ROLE).toContain('You are a Builder.');
    expect(existsSync(pane.launch.env.FLEET_CREW_SETTINGS)).toBe(true);
    expect(stepStatus(jobId, 'front')).toBe('running');
    expect(crewOf(jobId)).toMatchObject([
      { label: 'builder 1', stepId: 'front', runtime: 'claude', status: 'starting' }
    ]);
    expect(service.store.plans.logTail(jobId).at(-1)?.text).toBe('Hired builder 1 for step front');
  });

  it("gives a reader of another step's worktree a hand-back folder outside it", async () => {
    const jobId = await approvedJob([
      step('fix'),
      step('review', {
        role: 'reviewer',
        after: ['fix'],
        workspace: { of: 'fix' },
        deliverables: ['review']
      })
    ]);
    await toolsOf(jobId).crewHire!({ step: 'fix', brief: 'Fix it.' });
    service.jobs.updateStep(jobId, { step: 'fix', status: 'done' });
    await toolsOf(jobId).crewHire!({ step: 'review', brief: 'Review it.' });

    const folder = join(home.dir, 'agency-home', 'jobs', '1', 'handback', 'review');
    const [fix, review] = panes.opened;
    expect(fix.launch.env.FLEET_CREW_ADD_DIR_0).toBeUndefined();
    expect(review.launch.env.FLEET_CREW_ADD_DIR_0).toBe(folder);
    expect(review.launch.cmd).toContain('--add-dir "$FLEET_CREW_ADD_DIR_0"');
    expect(existsSync(folder)).toBe(true);
    expect(review.prompt).toContain(`Write each file it hands back in ${folder}.`);
  });

  it('is not offered in the lobby', () => {
    const lobby = toolsOf(null);
    expect([lobby.crewHire, lobby.crewSend, lobby.crewInterrupt, lobby.crewStop]).toEqual([
      null,
      null,
      null,
      null
    ]);
  });

  it('refuses a step outside the approved plan, and one already working', async () => {
    const jobId = await approvedJob();
    const tools = toolsOf(jobId);
    await expect(tools.crewHire!({ step: 'other', brief: 'x' })).rejects.toThrow(
      'step other is not in the approved plan'
    );
    await tools.crewHire!({ step: 'front', brief: 'x' });
    await expect(tools.crewHire!({ step: 'front', brief: 'x' })).rejects.toThrow(
      'builder 1 (id-0001-) is working on step front'
    );
    expect(panes.opened).toHaveLength(1);
  });

  it('refuses a step whose after steps are not done', async () => {
    const jobId = await approvedJob([step('front'), step('back', { after: ['front'] })]);
    await expect(toolsOf(jobId).crewHire!({ step: 'back', brief: 'x' })).rejects.toThrow(
      'Step back waits on front.'
    );
  });

  it('queues a step over the crew limit, without opening a pane', async () => {
    service.close();
    start(1);
    const jobId = await approvedJob([
      step('front', { scope: 'front' }),
      step('back', { scope: 'back' })
    ]);
    const tools = toolsOf(jobId);
    await tools.crewHire!({ step: 'front', brief: 'x' });
    const out = await tools.crewHire!({ step: 'back', brief: 'x' });

    expect(out.summary).toBe('back queued');
    expect(stepStatus(jobId, 'back')).toBe('queued');
    expect(panes.opened).toHaveLength(1);
  });

  it('puts the step back and ends the member when the pane cannot open', async () => {
    const jobId = await approvedJob();
    panes.openError = 'The Fleet window is not open.';
    await expect(toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' })).rejects.toThrow(
      'Not hired: The Fleet window is not open.'
    );
    expect(stepStatus(jobId, 'front')).toBe('pending');
    expect(crewOf(jobId)).toMatchObject([{ status: 'ended' }]);
  });
});

describe('stack slots', () => {
  async function oneSlot(fixedPort: number): Promise<void> {
    const scan = await service.projects.scan(ref);
    await service.projects.saveSetup(
      {
        repo: ref,
        setup: {
          ...scan.setup,
          stackSlots: 1,
          members: scan.setup.members.map((m) => ({
            ...m,
            fixedPorts: [{ port: fixedPort, service: 'postgres' }]
          }))
        },
        imports: []
      },
      { finish: true }
    );
  }

  const qaJob = async (): Promise<number> =>
    approvedJob([
      step('build'),
      step('qa', { role: 'qa', after: ['build'], deliverables: ['report'] })
    ]);

  /** A port nothing listens on, then a server outside Fleet on it while `held`. */
  async function outsideServer(): Promise<{
    port: number;
    listen: () => Promise<void>;
    close: () => Promise<void>;
  }> {
    const server = createServer();
    const port = await new Promise<number>((done) =>
      server.listen(0, () => {
        const address = server.address();
        done(typeof address === 'object' && address !== null ? address.port : 0);
      })
    );
    const close = async (): Promise<void> =>
      new Promise((done) => (server.listening ? server.close(() => done()) : done()));
    await close();
    return {
      port,
      listen: async () => new Promise((done) => server.listen(port, () => done())),
      close
    };
  }

  it('lets one job run the stack at a time while the builders of both keep working', async () => {
    const outside = await outsideServer();
    await oneSlot(outside.port);
    const [one, two] = [await qaJob(), await qaJob()];
    for (const jobId of [one, two]) {
      await toolsOf(jobId).crewHire!({ step: 'build', brief: 'x' });
      service.jobs.updateStep(jobId, { step: 'build', status: 'done' });
    }
    expect(panes.opened.map((p) => p.label)).toEqual(['builder 1', 'builder 1']);

    await toolsOf(one).crewHire!({ step: 'qa', brief: 'x' });
    const out = await toolsOf(two).crewHire!({ step: 'qa', brief: 'x' });
    expect(out.text).toContain(
      'Step qa is queued: Waiting for a stack slot: the project runs one stack at a time.'
    );
    expect(stepStatus(two, 'qa')).toBe('queued');
    expect(service.store.plans.step(two, 'qa')?.note).toBe(
      'Waiting for a stack slot: the project runs one stack at a time.'
    );
    expect(panes.opened.at(-1)?.prompt).toContain('You run the stack');

    // The first QA finishes, then its pane exits: the slot is free.
    service.jobs.updateStep(one, { step: 'qa', status: 'done' });
    expect(stepStatus(two, 'qa')).toBe('queued');
    service.crew.ended(panes.opened.at(-1)?.paneId ?? '', { kind: 'exit', exitCode: 0 });
    expect(stepStatus(two, 'qa')).toBe('pending');
    expect(service.store.plans.step(two, 'qa')?.note).toBe('');
  });

  it('counts a fixed port a program outside Fleet holds as a taken slot, until it lets go', async () => {
    const outside = await outsideServer();
    await oneSlot(outside.port);
    const jobId = await qaJob();
    await toolsOf(jobId).crewHire!({ step: 'build', brief: 'x' });
    service.jobs.updateStep(jobId, { step: 'build', status: 'done' });
    await outside.listen();

    const out = await toolsOf(jobId).crewHire!({ step: 'qa', brief: 'x' });
    expect(out.text).toContain(
      `A program outside Fleet listens on port ${outside.port}, which takes one; Fleet does not stop it.`
    );
    await service.stack.poll();
    expect(stepStatus(jobId, 'qa')).toBe('queued');

    await outside.close();
    await service.stack.poll();
    expect(stepStatus(jobId, 'qa')).toBe('pending');
  });
});

describe('a crew member at work', () => {
  async function hired(): Promise<{ jobId: number; paneId: string }> {
    const jobId = await approvedJob();
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    return { jobId, paneId: panes.opened[0].paneId };
  }

  it('is live once its session reports, and takes prompts marked as the Admiral’s', async () => {
    const { jobId, paneId } = await hired();
    const tools = toolsOf(jobId);
    await expect(tools.crewSend!({ crew: 'builder 1', prompt: 'Go on.' })).rejects.toThrow(
      'has not reported yet'
    );

    service.crew.reported(paneId, 'session-a');
    const out = await tools.crewSend!({ crew: 'Builder 1', prompt: 'Go on.', why: 'it asked' });

    expect(crewOf(jobId)[0].status).toBe('live');
    expect(panes.sent).toEqual([['session-a', '[admiral] Go on.']]);
    expect(out.text).toContain('It took it');
    expect(service.store.plans.logTail(jobId).at(-1)).toMatchObject({
      kind: 'crew',
      text: 'Sent builder 1 a prompt'
    });
  });

  it('counts and logs a prompt that arrived different, and fails the send', async () => {
    const { jobId, paneId } = await hired();
    service.crew.reported(paneId, 'session-a');
    panes.sendResult = { ok: false, reason: PROMPT_MISMATCH };
    await expect(toolsOf(jobId).crewSend!({ crew: 'builder 1', prompt: 'Go on.' })).rejects.toThrow(
      PROMPT_MISMATCH
    );
    expect(service.store.plans.logTail(jobId).at(-1)).toMatchObject({
      kind: 'crew',
      text: 'Sent builder 1 a prompt that arrived different'
    });
  });

  it('is interrupted with Esc, and found by its ref', async () => {
    const { jobId, paneId } = await hired();
    await toolsOf(jobId).crewInterrupt!({ crew: paneId.slice(0, 8) });
    expect(panes.written).toEqual([[paneId, '\x1b']]);
  });

  it('is the only pane its job’s fleet tools see', async () => {
    const { jobId, paneId } = await hired();
    expect([...service.crewPanes(jobId)]).toEqual([paneId]);
    expect([...service.crewPanes(null)]).toEqual([]);
  });

  it('stops on crew_stop, leaving its step for another hire', async () => {
    const { jobId, paneId } = await hired();
    await toolsOf(jobId).crewStop!({ crew: 'builder 1', why: 'wrong approach' });

    expect(panes.killed).toEqual([paneId]);
    expect(crewOf(jobId)[0]).toMatchObject({
      status: 'ended',
      endReason: 'stopped by the Admiral'
    });
    expect(stepStatus(jobId, 'front')).toBe('running');
    // The pane closing after the stop changes nothing more.
    service.crew.ended(paneId, { kind: 'closed' });
    expect(service.store.listQuestions(ref.repoId, { jobId })).toEqual([]);

    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'Start again.' });
    expect(panes.opened.at(-1)?.label).toBe('builder 2');
  });

  it('fails its step when its runtime ends, and asks the client before another hire', async () => {
    const { jobId, paneId } = await hired();
    service.crew.ended(paneId, { kind: 'exit', exitCode: 1 });

    expect(stepStatus(jobId, 'front')).toBe('failed');
    const [card] = service.store.listQuestions(ref.repoId, { jobId });
    expect(card).toMatchObject({
      kind: 'rehire',
      step: 'front',
      question: 'Step front failed before it was done'
    });
    // Every step left waits on the client, so the job does too.
    expect(service.store.getJob(jobId)?.state).toBe('waiting');
    await expect(toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' })).rejects.toThrow(
      'j1 is waiting'
    );

    service.answer({ id: card.id, option: 0 });
    expect(stepStatus(jobId, 'front')).toBe('pending');
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    expect(stepStatus(jobId, 'front')).toBe('running');
  });

  it('stops its step when the client closes its pane', async () => {
    const { jobId, paneId } = await hired();
    service.crew.ended(paneId, { kind: 'closed' });

    expect(stepStatus(jobId, 'front')).toBe('stopped');
    expect(service.store.plans.step(jobId, 'front')?.note).toBe('was closed by you');
    expect(crewOf(jobId)[0].endReason).toBe('was closed by you');
  });
});

describe('crew reports and idle turns', () => {
  async function live(steps = [step('front')]): Promise<{ jobId: number; paneId: string }> {
    const jobId = await approvedJob(steps);
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const { paneId } = panes.opened[0];
    service.crew.reported(paneId, 'session-a');
    return { jobId, paneId };
  }

  /** The text of the wakeups due for the job, claimed so the next read starts fresh. */
  const wakeups = (jobId: number): string =>
    service.store.pullWakeups({ repoId: ref.repoId, jobId }).text ?? '';

  it('finishes the step on done, and wakes the Admiral with the summary and deliverables', async () => {
    const { jobId, paneId } = await live();
    wakeups(jobId);
    const out = service.crew.report({
      paneId,
      summary: 'Toggle built and tested',
      deliver: ['/tmp/front/notes.md']
    });

    expect(out).toBe('Reported step front done to the Admiral. Stop now.');
    expect(stepStatus(jobId, 'front')).toBe('done');
    expect(service.store.plans.step(jobId, 'front')?.note).toBe('Toggle built and tested');
    const text = wakeups(jobId);
    expect(text).toContain('builder 1 reported step front done: Toggle built and tested');
    expect(text).toContain('It delivered /tmp/front/notes.md: record each with job_deliver.');
    expect(service.store.plans.logTail(jobId).at(-1)).toMatchObject({
      kind: 'crew',
      text: 'builder 1 reported done: Toggle built and tested'
    });
  });

  it('blocks the step on blocked, and leaves it running on a question', async () => {
    const { jobId, paneId } = await live();
    service.crew.report({ paneId, status: 'question', summary: 'Keep the old API? I say yes' });
    expect(stepStatus(jobId, 'front')).toBe('running');
    expect(wakeups(jobId)).toContain('Answer it with crew_send');

    service.crew.report({ paneId, status: 'blocked', summary: 'The tests need a database' });
    expect(stepStatus(jobId, 'front')).toBe('blocked');
    expect(service.store.plans.step(jobId, 'front')?.note).toBe('The tests need a database');
  });

  it('refuses a report from a pane that is not working crew, or without a summary', async () => {
    const { jobId, paneId } = await live();
    expect(() => service.crew.report({ paneId: 'someone-else', summary: 'done' })).toThrow(
      'Not reported: this pane is not a working crew member.'
    );
    expect(() => service.crew.report({ paneId, summary: ' ' })).toThrow(
      'Not reported: a report needs a --summary.'
    );
    expect(() => service.crew.report({ paneId, status: 'finished', summary: 'x' })).toThrow(
      'Not reported'
    );
    service.crew.report({ paneId, summary: 'All done' });
    expect(() => service.crew.report({ paneId, summary: 'Again' })).toThrow(
      'Not reported: step front is done.'
    );
    expect(stepStatus(jobId, 'front')).toBe('done');
  });

  it('takes a turn that ends after a report as waiting, not idle', async () => {
    const { jobId, paneId } = await live();
    service.crew.report({ paneId, status: 'question', summary: 'Which color?' });
    wakeups(jobId);
    service.crew.turnEnded('session-a');
    expect(wakeups(jobId)).toBe('');
  });

  it('wakes the Admiral on each idle turn, and blocks the step past the nudge limit', async () => {
    const { jobId } = await live();
    wakeups(jobId);
    // The client's limit is the default 3 nudges.
    service.crew.turnEnded('session-a');
    const first = wakeups(jobId);
    expect(first).toContain('builder 1 ended a turn on step front without reporting');
    expect(first).toContain('It has 3 prompts left before the step is blocked.');
    service.crew.turnEnded('session-a');
    expect(wakeups(jobId)).toContain('ended 2 turns in a row on step front without reporting');
    service.crew.turnEnded('session-a');
    expect(wakeups(jobId)).toContain('This is its last prompt before the step is blocked.');
    expect(stepStatus(jobId, 'front')).toBe('running');

    service.crew.turnEnded('session-a');
    expect(stepStatus(jobId, 'front')).toBe('blocked');
    expect(service.store.plans.step(jobId, 'front')?.note).toBe(
      'builder 1 ended 4 turns in a row without reporting'
    );
    expect(wakeups(jobId)).toContain(
      'Step front is blocked: builder 1 ended 4 turns in a row without reporting'
    );
  });

  it('starts counting again after a report', async () => {
    const { jobId, paneId } = await live();
    for (let i = 0; i < 3; i++) service.crew.turnEnded('session-a');
    service.crew.report({ paneId, status: 'question', summary: 'Which color?' });
    service.crew.turnEnded('session-a');
    for (let i = 0; i < 3; i++) service.crew.turnEnded('session-a');
    expect(stepStatus(jobId, 'front')).toBe('running');
  });

  it('ignores a turn from a session that is no crew member', async () => {
    const { jobId } = await live();
    wakeups(jobId);
    service.crew.turnEnded('session-b');
    expect(wakeups(jobId)).toBe('');
  });
});

describe('after a restart', () => {
  it('resumes the member a restart took, in its worktree and conversation', async () => {
    const jobId = await approvedJob();
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const first = panes.opened[0];
    service.close();

    // Crew processes end with Fleet.
    panes = fakePanes();
    start();
    await service.startup();
    expect(stepStatus(jobId, 'front')).toBe('interrupted');
    const resume = service.store
      .listQuestions(ref.repoId, { jobId })
      .find((q) => q.kind === 'resume');
    service.answer({ id: resume!.id, option: 0 });

    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'Fleet restarted. Go on.' });
    const [again] = panes.opened;
    expect(again.launch.cmd).toMatch(/^claude --resume "\$FLEET_CREW_SESSION_ID" /);
    expect(again.launch.env.FLEET_CREW_SESSION_ID).toBe(first.launch.env.FLEET_CREW_SESSION_ID);
    expect(again.cwd).toBe(first.cwd);
    expect(again.label).toBe('builder 1');
    const crew = service.store.crew.all(jobId);
    expect(crew.at(-1)?.replaces).toBe(crew[0].id);
    expect(stepStatus(jobId, 'front')).toBe('running');
  });
});

describe('crew flags', () => {
  async function hired(steps = [step('front')]): Promise<{ jobId: number; paneId: string }> {
    const jobId = await approvedJob(steps);
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    return { jobId, paneId: panes.opened[0].paneId };
  }

  async function live(steps = [step('front')]): Promise<{ jobId: number; paneId: string }> {
    const hire = await hired(steps);
    service.crew.reported(hire.paneId, 'session-a');
    panes.sessions.set('session-a', {
      phase: 'waitingForInput',
      waitingKind: 'prompt',
      lastActivity: clock
    });
    return hire;
  }

  const wakeups = (jobId: number): string =>
    service.store.pullWakeups({ repoId: ref.repoId, jobId }).text ?? '';
  const flagOf = (jobId: number) => crewOf(jobId)[0];

  it('marks a hire that has not started after a minute as needing the client, with its screen readable', async () => {
    const { jobId, paneId } = await hired();
    panes.screens.set(paneId, 'Do you trust the files in this folder?');
    clock += NEEDS_YOU_MS - 1;
    service.crew.flags.tick();
    expect(flagOf(jobId).flag).toBeNull();

    clock += 1;
    service.crew.flags.tick();
    expect(flagOf(jobId).flag).toBe('needs-you');
    expect(wakeups(jobId)).toContain('builder 1 has not started a minute after its hire');
    expect(await service.crewScreen(jobId, paneId)).toBe('Do you trust the files in this folder?');

    service.crew.reported(paneId, 'session-a');
    expect(flagOf(jobId).flag).toBeNull();
    expect(await service.crewScreen(jobId, paneId)).toBeNull();
  });

  it('hands a member to the client when they type in its pane, until they hand it back', async () => {
    const { jobId, paneId } = await live();
    const tools = toolsOf(jobId);
    wakeups(jobId);
    service.crew.flags.userInput(paneId, '\x1b[I');
    expect(flagOf(jobId).flag).toBeNull();
    panes.sessions.set('session-a', {
      phase: 'waitingForApproval',
      waitingKind: null,
      lastActivity: clock
    });
    service.crew.flags.userInput(paneId, '1');
    expect(flagOf(jobId).flag).toBeNull();

    panes.sessions.set('session-a', {
      phase: 'processing',
      waitingKind: null,
      lastActivity: clock
    });
    service.crew.flags.userInput(paneId, '\x1b');
    expect(flagOf(jobId).flag).toBe('user-driven');
    expect(wakeups(jobId)).toContain('The client took over builder 1 in its pane');
    await expect(tools.crewSend!({ crew: 'builder 1', prompt: 'go on' })).rejects.toThrow(
      'Not sent: the client took over builder 1. Wait until they hand it back from CREW.'
    );
    await expect(tools.crewInterrupt!({ crew: 'builder 1' })).rejects.toThrow('Not interrupted');
    await expect(tools.crewStop!({ crew: 'builder 1' })).rejects.toThrow('Not stopped');
    service.crew.turnEnded('session-a');
    expect(wakeups(jobId)).toBe('');

    service.crew.flags.handBack(flagOf(jobId).id);
    expect(flagOf(jobId).flag).toBeNull();
    expect(wakeups(jobId)).toContain('The client handed builder 1 back');
    panes.sessions.set('session-a', {
      phase: 'waitingForInput',
      waitingKind: 'prompt',
      lastActivity: clock
    });
    await expect(tools.crewSend!({ crew: 'builder 1', prompt: 'go on' })).resolves.toBeDefined();
  });

  it('holds a member and new hires of its runtime at a usage limit until it resets', async () => {
    clock = new Date(2026, 9, 17, 13, 0).getTime();
    const { jobId } = await live([
      step('front', { scope: 'front' }),
      step('back', { scope: 'back' })
    ]);
    wakeups(jobId);
    service.crew.flags.turnFailed('session-a', 'rate_limit', "You've hit your limit · resets 3pm");

    expect(flagOf(jobId)).toMatchObject({
      flag: 'limited',
      flagUntil: new Date(2026, 9, 17, 15, 0).getTime()
    });
    const limited = wakeups(jobId);
    expect(limited).toContain('builder 1 hit its Claude Code usage limit until 15:00');
    expect(limited).toContain('propose a plan change that swaps step front to eva');
    const tools = toolsOf(jobId);
    await expect(tools.crewSend!({ crew: 'builder 1', prompt: 'go on' })).rejects.toThrow(
      'Not sent: builder 1 is at its usage limit until 15:00.'
    );
    await expect(tools.crewHire!({ step: 'back', brief: 'x' })).rejects.toThrow(
      'Not hired: Claude Code is at its usage limit until 15:00, which builder 1 hit.'
    );

    clock = new Date(2026, 9, 17, 15, 0).getTime();
    service.crew.flags.tick();
    expect(flagOf(jobId).flag).toBeNull();
    expect(wakeups(jobId)).toContain("builder 1's usage limit has reset");
  });

  it('wakes the Admiral on another API error without holding the member', async () => {
    const { jobId } = await live();
    wakeups(jobId);
    service.crew.flags.turnFailed('session-a', 'overloaded', 'API Error: Overloaded');
    expect(flagOf(jobId).flag).toBeNull();
    expect(wakeups(jobId)).toContain("builder 1's turn ended on an API error (overloaded)");
  });

  it('marks a turn with no hook event for a long time as stuck, until it moves again', async () => {
    const { jobId } = await live();
    panes.sessions.set('session-a', {
      phase: 'processing',
      waitingKind: null,
      lastActivity: clock
    });
    clock += STUCK_MS;
    service.crew.flags.tick();
    expect(flagOf(jobId).flag).toBe('stuck');
    expect(wakeups(jobId)).toContain('builder 1 shows no progress for 15 minutes');

    panes.sessions.set('session-a', {
      phase: 'processing',
      waitingKind: null,
      lastActivity: clock + 1
    });
    service.crew.flags.tick();
    expect(flagOf(jobId).flag).toBeNull();
  });
});

describe('a swap', () => {
  /** The brief a pane got, typed or in its brief file. */
  const briefOf = (pane: CrewPaneOpen): string => {
    const file = /is in (\S+brief\.md)\./.exec(pane.prompt)?.[1];
    return file === undefined ? pane.prompt : readFileSync(file, 'utf8');
  };

  /** Propose `steps` as a change to the approved plan; its plan version id. */
  async function change(jobId: number, steps: PlanInput['steps']): Promise<number> {
    const plan = PlanSchema.parse({ playbook: 'feature', summary: 's', steps, budget: { usd: 5 } });
    const out = await toolsOf(jobId).jobPlan!(plan);
    return Number(/plan#(\d+)/.exec(out.summary)?.[1]);
  }

  const back = step('back', { scope: 'back' });

  /**
   * Builder 1 on step front, with a changed and a new file and a question
   * open, swapped to another model. Step back keeps the job running.
   */
  async function swapped(choice: 'continue' | 'restart'): Promise<{
    jobId: number;
    first: CrewPaneOpen;
  }> {
    const jobId = await approvedJob([step('front', { scope: 'front' }), back]);
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const first = panes.opened[0];
    service.crew.reported(first.paneId, 'session-a');
    writeFileSync(join(first.cwd, 'a.txt'), 'changed\n');
    writeFileSync(join(first.cwd, 'new.txt'), 'n');
    service.store.askQuestion({
      repoId: ref.repoId,
      jobId,
      kind: 'ask',
      step: 'front',
      planVersion: 1,
      question: 'Keep the old toggle?',
      context: '',
      options: [{ label: 'Yes' }, { label: 'No' }],
      recommended: 0
    });
    const id = await change(jobId, [step('front', { scope: 'front', model: 'opus' }), back]);
    const decided = await service.jobs.decide({
      planVersionId: id,
      action: 'approve',
      swaps: { front: choice }
    });
    if (!decided.ok) throw new Error(decided.reason);
    await new Promise((r) => setImmediate(r));
    return { jobId, first };
  }

  it('stops the old member first, and continues its work in the same worktree with a handoff', async () => {
    const { jobId, first } = await swapped('continue');
    expect(panes.killed).toEqual([first.paneId]);

    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'It built half the toggle.' });
    const next = panes.opened[1];
    expect(next.cwd).toBe(first.cwd);
    expect(next.launch.env.FLEET_CREW_MODEL).toBe('opus');
    const brief = briefOf(next);
    expect(brief).toContain('It built half the toggle.');
    expect(brief).toContain(
      'builder 1 worked on this step on Claude Code before you. You continue its work: its worktree is yours as it left it, uncommitted changes included.'
    );
    expect(brief).toMatch(
      /Changes in solo since the base [0-9a-f]{7} \(git diff [0-9a-f]{40}\):\n a\.txt \| 2/
    );
    expect(brief).toContain('New files git does not track yet: new.txt');
    expect(brief).toContain('Open questions for this step:\n- Keep the old toggle?');
    expect(readFileSync(join(next.cwd, 'a.txt'), 'utf8')).toBe('changed\n');

    const [old, now] = service.store.crew.all(jobId);
    expect(now).toMatchObject({
      label: 'builder 2',
      replaces: old.id,
      workspaceId: old.workspaceId
    });
    expect(service.store.plans.logTail(jobId).at(-1)?.text).toBe(
      'Hired builder 2 for step front in place of builder 1'
    );
  });

  it('starts over on a new branch from the base, keeping the old worktree', async () => {
    const { jobId, first } = await swapped('restart');
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const next = panes.opened[1];

    expect(next.cwd).toBe(join(home.dir, 'agency-home', 'jobs', '1', 'ws', 'front-2'));
    expect(readFileSync(join(next.cwd, 'a.txt'), 'utf8')).toBe('a');
    expect(existsSync(join(first.cwd, 'new.txt'))).toBe(true);
    const brief = briefOf(next);
    expect(brief).toContain(
      'builder 1 worked on this step on Claude Code before you. You start over from the base on a new branch. Its work stays on the branch admiral/j1/front-1, which you do not use.'
    );
    expect(brief).toContain('- Keep the old toggle?');
    const [old, now] = service.store.crew.all(jobId);
    expect(now.replaces).toBe(old.id);
  });

  it('hands over only once: a later hire for the step is a plain one', async () => {
    const { jobId } = await swapped('continue');
    const tools = toolsOf(jobId);
    await tools.crewHire!({ step: 'front', brief: 'x' });
    await tools.crewStop!({ crew: 'builder 2' });
    await tools.crewHire!({ step: 'front', brief: 'Plain.' });

    expect(briefOf(panes.opened[2])).not.toContain('before you');
    expect(service.store.crew.all(jobId)[2].replaces).toBeNull();
  });

  it('waits for nothing on a proposed swap: the member works on until the client approves', async () => {
    const jobId = await approvedJob();
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const id = await change(jobId, [step('front', { runtime: 'eva' })]);

    const card = service.jobs.detail(jobId)?.versions.find((v) => v.id === id);
    expect(card?.effects?.swaps).toEqual([{ stepId: 'front', fields: ['runtime'] }]);
    expect(card?.effects?.stopCrew).toMatchObject([{ label: 'builder 1' }]);
    expect(panes.killed).toEqual([]);
    expect(crewOf(jobId)[0].status).not.toBe('ended');
  });

  it('is proposed from a crew card as the client’s plan change, and refused while one waits', async () => {
    const jobId = await approvedJob();
    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const swap = { jobId, stepId: 'front', role: 'builder', runtime: null, model: null };

    expect(await service.jobs.swapStep(swap)).toEqual({
      ok: false,
      reason: 'The step runs that way now.'
    });
    const out = await service.jobs.swapStep({ ...swap, runtime: 'eva' });
    expect(out).toEqual({ ok: true, version: 2 });
    const card = service.jobs.detail(jobId)?.versions.find((v) => v.version === 2);
    expect(card).toMatchObject({ author: 'client', status: 'proposed' });
    expect(card?.plan.steps[0]).toMatchObject({ id: 'front', runtime: 'eva' });
    expect(card?.effects?.swaps).toEqual([{ stepId: 'front', fields: ['runtime'] }]);
    expect(service.store.pullWakeups({ repoId: ref.repoId, jobId }).text).toContain(
      'Client swapped step front on a crew card, as plan v2'
    );

    expect(await service.jobs.swapStep({ ...swap, model: 'opus' })).toMatchObject({
      ok: false,
      reason: 'Plan v2 is waiting for you. Approve or reject it first.'
    });
  });

  it('keeps the role the plan was approved with when the role file changes', async () => {
    const draft = {
      name: 'tester',
      description: 'Tests things.',
      runtime: 'claude' as const,
      stack: false,
      instructions: 'You are the old tester.'
    };
    expect(
      await service.saveCrewRole({ repoId: ref.repoId, base: null, role: draft })
    ).toMatchObject({ ok: true });
    const jobId = await approvedJob([step('front', { role: 'tester' })]);
    expect(
      await service.saveCrewRole({
        repoId: ref.repoId,
        base: draft,
        role: { ...draft, instructions: 'You are the new tester.' }
      })
    ).toMatchObject({ ok: true });

    await toolsOf(jobId).crewHire!({ step: 'front', brief: 'x' });
    const role = panes.opened[0].launch.env.FLEET_CREW_ROLE;
    expect(role).toContain('You are the old tester.');
    expect(role).not.toContain('new tester');
  });
});
