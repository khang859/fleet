import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENCY_SETTINGS,
  type AdmiralThreadScope,
  type AgencyChanged
} from '../../../shared/agency';
import { AgencyService } from '../index';
import { createAgencyCapability } from '../tools';
import { admiralSnapshotNote } from '../admiral/snapshot-note';
import { OTHER_REPO, REPO, YES_NO } from './fixture';

let dir: string;
let emitted: AgencyChanged[];
let service: AgencyService;
let lobby: AdmiralThreadScope;

const settings = (): typeof DEFAULT_AGENCY_SETTINGS => ({
  ...DEFAULT_AGENCY_SETTINGS,
  enabled: true,
  admiral: { ...DEFAULT_AGENCY_SETTINGS.admiral, defaultBudgetUsd: 25 }
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-tools-'));
  emitted = [];
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: (change) => emitted.push(change),
    hasModelKey: () => true
  });
  service.ensureLobby(REPO);
  lobby = { repoId: REPO.repoId, jobId: null };
});
afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const openJob = (title = 'Fix the login bug'): ReturnType<AgencyService['openJob']> =>
  service.openJob({ repoId: REPO.repoId, title, brief: `${title}, please`, budgetUsd: null });

describe('ask_client', () => {
  it('posts a card in the thread scope, numbering options from 1 as the card does', async () => {
    const job = openJob();
    const tools = createAgencyCapability(service, { repoId: REPO.repoId, jobId: job.id }, settings);
    emitted = [];

    const out = await tools.askClient({
      question: 'Keep the old endpoint?',
      context: 'Two clients still call it.',
      options: YES_NO,
      recommended: 2
    });

    const [question] = service.store.listQuestions(REPO.repoId, { jobId: job.id });
    expect(question).toMatchObject({ jobId: job.id, recommended: 1, status: 'open' });
    expect(out.text).toContain(`q${question.id} is up for the client`);
    expect(emitted).toEqual([{ repoId: REPO.repoId, jobIds: [job.id] }]);
  });

  it('holds a question that waits on an earlier answer', async () => {
    const tools = createAgencyCapability(service, lobby, settings);
    await tools.askClient({ question: 'Ship today?', options: YES_NO });
    const [first] = service.store.listQuestions(REPO.repoId);

    const out = await tools.askClient({
      question: 'Which branch?',
      options: [{ label: 'main' }, { label: 'release' }],
      depends_on: { question: first.id, option: 1 }
    });

    expect(out.text).toContain(`held until q${first.id} is answered with option 1`);
    const held = service.store.listQuestions(REPO.repoId, { statuses: ['hidden'] });
    expect(held[0].dependsOn).toEqual({ question: first.id, option: 0 });
  });

  it('refuses a recommendation that is not one of the options', async () => {
    const tools = createAgencyCapability(service, lobby, settings);

    await expect(
      tools.askClient({ question: 'Ship?', options: YES_NO, recommended: 3 })
    ).rejects.toThrow('The recommended option 3 is not one of the options');
  });
});

describe('job_open', () => {
  it('opens a job from the lobby on the default budget and names it as opened', async () => {
    const tools = createAgencyCapability(service, lobby, settings);
    emitted = [];

    const out = await tools.jobOpen?.({ title: 'Dark mode', brief: 'Add a dark theme' });

    const [job] = service.store.listJobs(REPO.repoId);
    expect(job).toMatchObject({ title: 'Dark mode', budgetUsd: 25, state: 'briefing' });
    expect(job.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(out?.text).toContain(`Opened j${job.id}`);
    expect(emitted).toEqual([{ repoId: REPO.repoId, jobIds: [job.id], openedJobId: job.id }]);
  });

  it('is not there in a job thread', () => {
    const job = openJob();
    const tools = createAgencyCapability(service, { repoId: REPO.repoId, jobId: job.id }, settings);

    expect(tools.jobOpen).toBeNull();
  });
});

describe('job_list', () => {
  it("lists the repository's open jobs with what waits on the client", async () => {
    const job = openJob();
    openJob('Dark mode');
    service.ask({ repoId: REPO.repoId, jobId: job.id }, { question: 'Ship?', options: YES_NO });
    service.ensureLobby(OTHER_REPO);
    service.openJob({ repoId: OTHER_REPO.repoId, title: 'Elsewhere', brief: 'x', budgetUsd: null });

    const out = await createAgencyCapability(service, lobby, settings).jobList({});

    expect(out.text).toBe(
      [
        `- j${job.id} "Fix the login bug": briefing, 1 waiting on the client`,
        `- j${job.id + 1} "Dark mode": briefing, nothing waiting on the client`
      ].join('\n')
    );
  });

  it('says so when there are none', async () => {
    const out = await createAgencyCapability(service, lobby, settings).jobList({});

    expect(out.text).toBe('There are no open jobs.');
  });
});

describe('threadScope', () => {
  it("accepts the lobby's own session and a job's own session", () => {
    const job = openJob();
    const lobbyId = service.store.lobbySessionId(REPO.repoId) ?? '';

    expect(service.threadScope({ ...lobby, threadId: lobbyId })).toEqual(lobby);
    expect(
      service.threadScope({ repoId: REPO.repoId, jobId: job.id, threadId: job.sessionId })
    ).toEqual({ repoId: REPO.repoId, jobId: job.id });
  });

  it("refuses another repository's job, another thread, and an unknown repository", () => {
    const job = openJob();
    service.ensureLobby(OTHER_REPO);

    expect(() =>
      service.threadScope({ repoId: OTHER_REPO.repoId, jobId: job.id, threadId: job.sessionId })
    ).toThrow(`j${job.id} is not a job in other`);
    expect(() =>
      service.threadScope({ repoId: REPO.repoId, jobId: job.id, threadId: 'not-its-session' })
    ).toThrow(`This conversation is not j${job.id}'s.`);
    expect(() => service.threadScope({ ...lobby, threadId: job.sessionId })).toThrow(
      'This conversation is not the lobby of fleet.'
    );
    expect(() => service.threadScope({ repoId: 'nope', jobId: null, threadId: 'x' })).toThrow(
      'Fleet has no record of the repository'
    );
  });
});

describe('admiralSnapshotNote', () => {
  it('gives a job thread its job and every option of its open questions', () => {
    const job = openJob();
    const scope = { repoId: REPO.repoId, jobId: job.id };
    service.ask(scope, { question: 'Keep the old endpoint?', options: YES_NO, recommended: 0 });

    const note = admiralSnapshotNote(service.store, scope);

    expect(note).toContain(`j${job.id} in fleet, state briefing.`);
    // What the Admiral wrote is quoted, not stated by Fleet.
    expect(note).toContain(
      `<session-data session="j${job.id}">\nTitle: Fix the login bug\nBrief: Fix the login bug, please`
    );
    expect(note).toMatch(/<session-data session="q\d+">\nq\d+: Keep the old endpoint\?\n/);
    expect(note).toContain('1. Yes (your recommendation)');
    expect(note).toContain('2. No - leave it as it is');
  });

  it('gives the lobby the open jobs', () => {
    const job = openJob();

    const note = admiralSnapshotNote(service.store, lobby);

    expect(note).toContain('the lobby of fleet');
    expect(note).toContain(`- j${job.id}: briefing, 0 questions waiting`);
    expect(note).toContain(`<session-data session="job titles">\nj${job.id}: Fix the login bug\n`);
    expect(note).toContain('No questions are waiting on the client.');
  });
});
