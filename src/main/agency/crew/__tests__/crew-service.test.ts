import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DEFAULT_AGENCY_SETTINGS, type AgencyRepoRef } from '../../../../shared/agency';
import { PlanSchema, PlanStepSchema, type PlanInput } from '../../../../shared/agency-plan';
import type { AgentAgencyCapability } from '../../../../shared/agency-tools';
import { AgencyService } from '../../index';
import { fakeGh, initRepo, tempDir } from '../../projects/__tests__/git-fixture';
import { createAgencyCapability } from '../../tools';
import { PROMPT_MISMATCH, type SendResult } from '../../../claude-sessions/input';
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
    hooks: () => ({})
  };
  return host;
}

let ids = 0;

function start(crewLimit = 4): void {
  service = new AgencyService({
    dbPath: join(home.dir, 'agency.db'),
    emit: () => {},
    hasModelKey: () => true,
    gh: fakeGh(() => ({ code: 0, stdout: '' })),
    agencyHome: join(home.dir, 'agency-home'),
    crewDirs: { bundled: join(process.cwd(), 'resources', 'crew'), user: null },
    crewPanes: panes,
    crewLimit: () => crewLimit,
    now: () => 1_000_000,
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
      `[admiral] - Build the toggle.\n\nOther jobs run servers too, so never use a default port. For any other server, pick a free port in ${block} (FLEET_PORTS).`
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
