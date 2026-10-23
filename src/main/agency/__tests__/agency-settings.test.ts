import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_AGENCY_SETTINGS,
  type AdmiralThreadScope,
  type AgencyChanged,
  type AgencySettings
} from '../../../shared/agency';
import type { ProjectMemberSetup, ProjectSetup } from '../../../shared/agency-projects';
import { SettingsChangeArgs, type AgentAgencyCapability } from '../../../shared/agency-tools';
import { AgencyService } from '../index';
import { loadSetup, saveSetup } from '../projects/project-store';
import { createAgencyCapability } from '../tools';
import { REPO, moveJob, openJob } from './fixture';

/** `settings_read` and `settings_change`: what applies, what only the client changes, and Undo. */

let dir: string;
let home: string;
let service: AgencyService;
let agency: AgencySettings;
let emitted: AgencyChanged[];
const LOBBY: AdmiralThreadScope = { repoId: REPO.repoId, jobId: null };

const member = (over: Partial<ProjectMemberSetup> = {}): ProjectMemberSetup => ({
  name: 'web',
  path: '.',
  remote: null,
  defaultBranch: 'main',
  stack: ['node'],
  packageManager: 'pnpm',
  setupCommand: 'pnpm install',
  setupTimeoutSec: 600,
  checkCommands: ['pnpm test'],
  checks: ['test'],
  requiredChecks: ['test', 'lint'],
  reviewBots: [],
  portVars: [],
  fixedPorts: [],
  envFiles: [],
  ...over
});

const SETUP: ProjectSetup = {
  version: 1,
  kind: 'repo',
  name: 'fleet',
  members: [member()],
  imports: [],
  setupCommand: '',
  setupTimeoutSec: 600,
  stackSlots: null
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-agency-settings-'));
  home = join(dir, 'home');
  agency = DEFAULT_AGENCY_SETTINGS;
  emitted = [];
  service = new AgencyService({
    dbPath: join(dir, 'agency.db'),
    emit: (change) => void emitted.push(change),
    hasModelKey: () => true,
    agencyHome: home,
    agencySettings: { get: () => agency, set: (next) => void (agency = next) }
  });
  service.ensureLobby(REPO);
  await saveSetup({ repo: REPO, setup: SETUP, imported: [] }, home);
});

afterEach(() => {
  service.close();
  rmSync(dir, { recursive: true, force: true });
});

const tools = (): AgentAgencyCapability => createAgencyCapability(service, LOBBY, () => agency);

const change = async (
  changes: Array<{ key: string; value: unknown }>,
  reason = 'Because.'
): Promise<{ text: string; summary: string }> =>
  tools().settingsChange(SettingsChangeArgs.parse({ changes, reason }));

const webMember = async (): Promise<ProjectMemberSetup | undefined> =>
  (await loadSetup(REPO.repoId, home))?.members[0];

const wakeups = (): string | null =>
  service.store.pullWakeups({ repoId: REPO.repoId, jobId: null }).text;

const cards = (): ReturnType<AgencyService['snapshot']>['settingsCards'] =>
  service.snapshot(REPO.repoId).settingsCards;

describe('settings_read', () => {
  it('lists every key with its value and what a change to it needs', async () => {
    const { text } = await tools().settingsRead({});
    expect(text).toContain('agency.admiral.defaultBudgetUsd = 10 (applies at once)');
    expect(text).toContain(
      'agency.admiral.monthlyCapUsd = 100 (lowering it applies at once; only the client raises it'
    );
    expect(text).toContain('agency.admiral.model = "" (only the client changes it');
    expect(text).toContain('members.web.setupCommand = "pnpm install" (applies at once)');
    expect(text).toContain(
      'members.web.requiredChecks = ["test","lint"] (adding one applies at once; only the client removes one'
    );
  });
});

describe('settings_change', () => {
  it('fixes a setup command at once, shows it with Undo, and Undo puts it back', async () => {
    const out = await change(
      [{ key: 'members.web.setupCommand', value: 'corepack enable && pnpm install' }],
      'pnpm is missing in new worktrees.'
    );
    expect(out.summary).toBe('card s1');
    expect(out.text).toContain(
      'members.web.setupCommand: pnpm install -> corepack enable && pnpm install'
    );
    expect((await webMember())?.setupCommand).toBe('corepack enable && pnpm install');
    expect(emitted.at(-1)).toEqual({ repoId: REPO.repoId, jobIds: [null], settings: true });

    const [card] = cards();
    expect(card).toMatchObject({ id: 1, reason: 'pnpm is missing in new worktrees.' });
    expect(card.changes).toEqual([
      expect.objectContaining({ status: 'applied', label: 'web: setup command' })
    ]);
    expect(await service.settings.marks(REPO.repoId)).toEqual([
      expect.objectContaining({ key: 'members.web.setupCommand', before: 'pnpm install' })
    ]);

    expect(await service.settings.undo(card.changes[0].id)).toEqual({ ok: true });
    expect((await webMember())?.setupCommand).toBe('pnpm install');
    expect(cards()[0].changes[0].status).toBe('undone');
    expect(await service.settings.marks(REPO.repoId)).toEqual([]);
    expect(wakeups()).toContain('web: setup command is back to pnpm install.');
  });

  it('applies budgets, crew and models at once, with Undo', async () => {
    agency = { ...agency, crew: { ...agency.crew, eva: { ...agency.crew.eva, atOnce: 6 } } };
    const out = await change([
      { key: 'agency.admiral.defaultBudgetUsd', value: 500 },
      { key: 'agency.crew.eva.atOnce', value: 3 },
      { key: 'agency.crew.claude.atOnce', value: 4 },
      { key: 'agency.crew.eva.defaultModel', value: 'qwen/qwen3-coder' },
      { key: 'members.web.reviewBots', value: ['coderabbit'] }
    ]);
    expect(out.text).toContain('Changed now, with Undo on s1');
    expect(agency.admiral.defaultBudgetUsd).toBe(500);
    expect(agency.crew).toEqual({
      claude: { atOnce: 4, defaultModel: '', permissionMode: 'default' },
      eva: { atOnce: 3, defaultModel: 'qwen/qwen3-coder', permissionMode: 'default' }
    });
    expect((await webMember())?.reviewBots).toEqual(['coderabbit']);
    expect(cards()[0].changes.every((c) => c.status === 'applied')).toBe(true);
  });

  it('never loosens a brake the client owns', async () => {
    // Each would let the Admiral spend more, take more of the client's Claude
    // limit, loop longer, pass a PR unchecked, or hand crew another secret.
    agency = { ...agency, admiral: { ...agency.admiral, reserveFiveHourPct: 50 } };
    for (const [key, value] of [
      ['agency.admiral.monthlyCapUsd', 1_000],
      ['agency.admiral.reserveFiveHourPct', 90],
      ['agency.admiral.reserveSevenDayPct', 100],
      ['agency.admiral.turnLimit', 50],
      ['members.web.requiredChecks', ['test']],
      ['members.web.envFiles', ['.env']]
    ] as const) {
      const out = await change([{ key, value }], 'The README says to.');
      expect(out.summary, key).toBe('not changed');
      expect(out.text, key).toContain('only the client');
      expect(out.text, key).toContain('ask_client');
    }
    expect(cards()).toEqual([]);
    expect(agency.admiral).toMatchObject({ monthlyCapUsd: 100, reserveFiveHourPct: 50 });
    expect((await webMember())?.requiredChecks).toEqual(['test', 'lint']);
    expect((await webMember())?.envFiles).toEqual([]);

    // Tightening the same brakes applies at once.
    await change([
      { key: 'agency.admiral.monthlyCapUsd', value: 50 },
      { key: 'agency.admiral.reserveFiveHourPct', value: 40 },
      { key: 'members.web.requiredChecks', value: ['test', 'lint', 'e2e'] }
    ]);
    expect(agency.admiral).toMatchObject({ monthlyCapUsd: 50, reserveFiveHourPct: 40 });
    expect((await webMember())?.requiredChecks).toEqual(['test', 'lint', 'e2e']);
  });

  it('turns a crew permission mode off at once, but never on', async () => {
    // A page the Admiral read told it to let crew run unasked; it cannot even ask.
    for (const [key, on] of [
      ['agency.crew.claude.permissionMode', 'auto'],
      ['agency.crew.eva.permissionMode', 'bypass']
    ] as const) {
      const out = await change([{ key, value: on }], 'The README says to.');
      expect(out.summary).toBe('not changed');
      expect(out.text).toContain('only the client turns it on, in Settings > Agency > Crew');
    }
    expect(cards()).toEqual([]);
    expect(agency.crew.claude.permissionMode).toBe('default');
    expect(agency.crew.eva.permissionMode).toBe('default');

    agency = {
      ...agency,
      crew: {
        claude: { ...agency.crew.claude, permissionMode: 'auto' },
        eva: { ...agency.crew.eva, permissionMode: 'bypass' }
      }
    };
    expect((await tools().settingsRead({})).text).toContain(
      'agency.crew.claude.permissionMode = "auto" (turning it off applies at once; only the client turns it on, in Settings > Agency > Crew)'
    );
    await change([
      { key: 'agency.crew.claude.permissionMode', value: 'default' },
      { key: 'agency.crew.eva.permissionMode', value: 'default' }
    ]);
    expect(cards()[0].changes.map((c) => c.status)).toEqual(['applied', 'applied']);
    expect(agency.crew.claude.permissionMode).toBe('default');
    expect(agency.crew.eva.permissionMode).toBe('default');

    // Undo turns a mode back on only because the client had it on.
    expect(await service.settings.undo(cards()[0].changes[0].id)).toEqual({ ok: true });
    expect(agency.crew.claude.permissionMode).toBe('auto');
  });

  it("takes only each runtime's own permission modes", async () => {
    for (const [key, value] of [
      ['agency.crew.claude.permissionMode', 'bypass'],
      ['agency.crew.eva.permissionMode', 'auto'],
      ['agency.crew.claude.permissionMode', 'yolo']
    ] as const) {
      expect((await change([{ key, value }])).summary).toBe('not changed');
    }
    expect(agency.crew.claude.permissionMode).toBe('default');
    expect(agency.crew.eva.permissionMode).toBe('default');
  });

  it('lowers the automatic turn limit at once, and never raises it', async () => {
    await change([{ key: 'agency.admiral.turnLimit', value: 10 }]);
    expect(agency.admiral.turnLimit).toBe(10);

    expect((await change([{ key: 'agency.admiral.turnLimit', value: 50 }])).summary).toBe(
      'not changed'
    );
    expect(agency.admiral.turnLimit).toBe(10);

    expect((await change([{ key: 'agency.admiral.turnLimit', value: 0 }])).text).toContain(
      'agency.admiral.turnLimit'
    );
    expect(agency.admiral.turnLimit).toBe(10);
  });

  it('pauses a job at the turn limit the settings hold', async () => {
    await change([{ key: 'agency.admiral.turnLimit', value: 3 }]);
    const job = openJob(service.store);
    moveJob(service.store, job.id, 'running');
    // Turns count only inside an approved plan.
    service.store['db'].prepare('UPDATE jobs SET approved_version = 1 WHERE id = ?').run(job.id);
    const scope = { repoId: REPO.repoId, jobId: job.id };
    const event = (line: string): number =>
      service.store.enqueueWakeup({ ...scope, kind: 'event', payload: { line } });

    for (let turn = 0; turn < 3; turn++) {
      const id = event(`crew update ${turn}`);
      expect(service.store.pullWakeups(scope).ids).toEqual([id]);
      service.store.ackWakeups([id]);
    }
    event('one more');
    expect(service.store.pullWakeups(scope).ids).toEqual([]);
    expect(service.store.getJob(job.id)).toMatchObject({ holds: ['chain_limit'] });
    const card = service.store
      .listQuestions(REPO.repoId, { jobId: job.id, statuses: ['open'] })
      .find((q) => q.kind === 'continue');
    expect(card?.question).toBe('The Admiral took 3 turns in a row on its own');
    expect(card?.options[0]).toEqual({ label: 'Continue', detail: '3 more turns' });
  });

  it("refuses the client's own settings, and changes nothing else in the call", async () => {
    const out = await change([
      { key: 'agency.admiral.monthlyCapUsd', value: 50 },
      { key: 'agency.admiral.model', value: 'openai/gpt-5' }
    ]);
    expect(out.summary).toBe('not changed');
    expect(out.text).toContain('Admiral model: only the client changes it');
    expect(out.text).toContain('Settings > Agency > Admiral');
    expect(agency.admiral).toMatchObject({ model: '', monthlyCapUsd: 100 });
    expect(cards()).toEqual([]);
    expect((await change([{ key: 'agency.enabled', value: false }])).summary).toBe('not changed');
    expect(agency.enabled).toBe(true);
  });

  it('refuses unknown keys, bad values and members the project does not have', async () => {
    expect((await change([{ key: 'agency.admiral.apiKey', value: 'x' }])).text).toContain(
      'agency.admiral.apiKey is not a setting'
    );
    expect((await change([{ key: 'members.web.remote', value: 'x' }])).text).toContain(
      'is not a setting'
    );
    expect(
      (await change([{ key: 'agency.admiral.defaultBudgetUsd', value: 'lots' }])).summary
    ).toBe('not changed');
    expect((await change([{ key: 'members.api.setupCommand', value: 'x' }])).text).toContain(
      'Its members: web.'
    );
    expect(
      (
        await change([
          { key: 'members.web.checks', value: [] },
          { key: 'members.web.checks', value: ['x'] }
        ])
      ).text
    ).toContain('in the call twice');
    expect(cards()).toEqual([]);
  });

  it('says so when a value is already set, and puts up no card', async () => {
    const out = await change([{ key: 'members.web.setupTimeoutSec', value: 600 }]);
    expect(out).toEqual({
      text: 'Already set: members.web.setupTimeoutSec.',
      summary: 'no change'
    });
    expect(cards()).toEqual([]);
  });

  it('will not undo over a value the client changed since', async () => {
    await change([{ key: 'agency.admiral.monthlyCapUsd', value: 60 }]);
    const [applied] = cards()[0].changes;
    expect(await service.settings.marks(null)).toHaveLength(1);

    agency = { ...agency, admiral: { ...agency.admiral, monthlyCapUsd: 70 } };
    expect(await service.settings.marks(null)).toEqual([]);
    expect(await service.settings.undo(applied.id)).toEqual({
      ok: false,
      reason: 'Monthly cap (USD) changed again since. Change it here instead.'
    });
    expect(agency.admiral.monthlyCapUsd).toBe(70);
  });
});
