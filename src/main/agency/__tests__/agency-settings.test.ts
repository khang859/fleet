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
import { REPO } from './fixture';

/** `settings_read` and `settings_change`: what applies, what waits on a card, and Undo. */

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
  ...over
});

const SETUP: ProjectSetup = {
  version: 1,
  kind: 'repo',
  name: 'fleet',
  members: [member()],
  imports: []
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
    expect(text).toContain(
      "agency.admiral.defaultBudgetUsd = 10 (lowering it applies at once; raising it needs the client's OK)"
    );
    expect(text).toContain('agency.admiral.model = "" (only the client changes it');
    expect(text).toContain('members.web.setupCommand = "pnpm install" (applies at once)');
    expect(text).toContain(
      'members.web.requiredChecks = ["test","lint"] (adding one applies at once; removing one needs the client\'s OK)'
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
      expect.objectContaining({ kind: 'apply', status: 'applied', label: 'web: setup command' })
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

  it('never applies a widening change without the client approving its card', async () => {
    const out = await change([
      { key: 'agency.admiral.defaultBudgetUsd', value: 500 },
      { key: 'agency.admiral.monthlyCapUsd', value: 1_000 },
      { key: 'members.web.requiredChecks', value: ['test'] },
      { key: 'members.web.reviewBots', value: ['coderabbit'] }
    ]);
    expect(out.text).toContain('Waiting for the client on s1');
    expect(agency.admiral).toMatchObject({ defaultBudgetUsd: 10, monthlyCapUsd: 100 });
    expect((await webMember())?.requiredChecks).toEqual(['test', 'lint']);
    // Waiting for one more bot gives nothing away, so it applied.
    expect((await webMember())?.reviewBots).toEqual(['coderabbit']);

    const pending = cards()[0].changes.filter((c) => c.status === 'pending');
    expect(pending.map((c) => c.key)).toEqual([
      'agency.admiral.defaultBudgetUsd',
      'agency.admiral.monthlyCapUsd',
      'members.web.requiredChecks'
    ]);

    expect(await service.settings.decide(pending[0].id, true)).toBe(true);
    expect(await service.settings.decide(pending[1].id, false)).toBe(true);
    expect(agency.admiral).toMatchObject({ defaultBudgetUsd: 500, monthlyCapUsd: 100 });
    expect((await webMember())?.requiredChecks).toEqual(['test', 'lint']);
    expect(cards()[0].changes.map((c) => c.status)).toEqual([
      'approved',
      'refused',
      'pending',
      'applied'
    ]);
    const woke = wakeups();
    expect(woke).toContain('Client approved Default job budget (USD) on s1');
    expect(woke).toContain('Client refused Monthly cap (USD) on s1');
    // A decided change cannot be decided again.
    expect(await service.settings.decide(pending[0].id, false)).toBe(false);
  });

  it('turns a request injected into a file into a card at most', async () => {
    // A README told the Admiral to raise the job budget to $500; all it can do is ask.
    await change([{ key: 'agency.admiral.defaultBudgetUsd', value: 500 }], 'The README says to.');
    expect(agency.admiral.defaultBudgetUsd).toBe(10);
    expect(cards()[0].changes[0]).toMatchObject({ kind: 'approve', status: 'pending' });
  });

  it("refuses the client's own settings, and changes nothing else in the call", async () => {
    const out = await change([
      { key: 'agency.admiral.monthlyCapUsd', value: 50 },
      { key: 'agency.admiral.model', value: 'openai/gpt-5' }
    ]);
    expect(out.summary).toBe('not changed');
    expect(out.text).toContain("Admiral model is the client's own setting");
    expect(out.text).toContain('Settings > Agency > Admiral');
    expect(agency.admiral).toMatchObject({ model: '', monthlyCapUsd: 100 });
    expect(cards()).toEqual([]);
    expect((await change([{ key: 'agency.enabled', value: false }])).summary).toBe('not changed');
    expect(agency.enabled).toBe(false);
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
