import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencySnapshot } from '../../../../../shared/agency';
import type { SettingChange, SettingsCard } from '../../../../../shared/agency-settings';
import { agencyJob } from '../../../../../shared/__tests__/agency-fixtures';
import { AdmiralChangeNote } from '../../settings/AdmiralChangeNote';
import { JobSheet } from '../JobSheet';
import { SettingsCardView } from '../SettingsCard';

/** Settings cards in the chat and under WAITING ON YOU, and "Changed by the Admiral". */

const REPO = '0123456789abcdef';

const change = (over: Partial<SettingChange> = {}): SettingChange => ({
  id: 1,
  key: 'members.web.setupCommand',
  label: 'web: setup command',
  before: 'pnpm install',
  after: 'corepack enable && pnpm install',
  kind: 'apply',
  status: 'applied',
  ...over
});

const card = (over: Partial<SettingsCard> = {}): SettingsCard => ({
  id: 3,
  repoId: REPO,
  jobId: null,
  at: 1,
  reason: 'pnpm is missing in new worktrees.',
  changes: [change()],
  ...over
});

const WIDER = change({
  id: 2,
  key: 'agency.admiral.defaultBudgetUsd',
  label: 'Default job budget (USD)',
  before: 10,
  after: 500,
  kind: 'approve',
  status: 'pending'
});

const snap = (over: Partial<AgencySnapshot> = {}): AgencySnapshot => ({
  repoId: REPO,
  lobbySessionId: 'lobby',
  jobs: [],
  questions: [],
  nextRetryAt: null,
  onboarding: { setupDoneAt: 1, starterDoneAt: 1 },
  leftovers: [],
  clientFileChanged: false,
  pastJobs: [],
  settingsCards: [],
  ...over
});

const sheet = (snapshot: AgencySnapshot, jobId: number | null = null): string =>
  renderToStaticMarkup(
    createElement(JobSheet, {
      snapshot,
      jobId,
      detail: undefined,
      working: false,
      defaultBudgetUsd: 10,
      onAnswer: async () => Promise.resolve(true),
      onOpenSettings: () => {}
    })
  );

const view = (c: SettingsCard): string =>
  renderToStaticMarkup(createElement(SettingsCardView, { card: c }));

describe('a settings card', () => {
  it('shows a change made at once with its old and new value and Undo', () => {
    const html = view(card());
    expect(html).toContain('aria-label="Settings s3"');
    expect(html).toContain('Settings changed');
    expect(html).toContain('pnpm is missing in new worktrees.');
    expect(html.indexOf('pnpm install<')).toBeLessThan(html.indexOf('corepack enable'));
    expect(html).toContain('line-through');
    expect(html).toContain('>Changed<');
    expect(html).toContain('aria-label="Undo web: setup command"');
    expect(html).not.toContain('>Approve<');
  });

  it('asks for each change that gives more, beside the ones already made', () => {
    const html = view(card({ changes: [change(), WIDER] }));
    expect(html).toContain('Change these settings?');
    expect(html).toContain('border-amber-400/35');
    expect(html).toContain('aria-label="Approve Default job budget (USD)"');
    expect(html).toContain('aria-label="Do not change Default job budget (USD)"');
    expect(html).toContain('aria-label="Undo web: setup command"');
    expect(html).not.toContain('aria-label="Undo Default job budget (USD)"');
  });

  it('says how a decided change ended', () => {
    const html = view(
      card({
        changes: [
          change({ status: 'undone' }),
          { ...WIDER, status: 'refused' },
          { ...WIDER, id: 4, status: 'approved' }
        ]
      })
    );
    expect(html).toContain('>Undone<');
    expect(html).toContain('>Not changed<');
    expect(html).toContain('>Approved<');
    expect(html).toContain('aria-label="Undo Default job budget (USD)"');
    expect(html).not.toContain('>Approve<');
  });
});

describe('the job sheet', () => {
  it('counts a settings card waiting on the client in its own job or lobby only', () => {
    const waiting = card({ changes: [WIDER] });
    const lobby = sheet(snap({ settingsCards: [card(), waiting] }));
    expect(lobby).toContain('WAITING ON YOU · 1');
    expect(lobby).toContain('aria-label="Settings s3"');

    const job = agencyJob({ id: 9, state: 'running' });
    const inJob = sheet(snap({ jobs: [job], settingsCards: [waiting] }), 9);
    expect(inJob).not.toContain('aria-label="Settings s3"');
    expect(inJob).not.toContain('WAITING ON YOU · 1');
  });
});

describe('Changed by the Admiral', () => {
  const marks = [
    {
      changeId: 7,
      key: 'agency.admiral.monthlyCapUsd',
      at: 1,
      reason: 'Cheaper jobs.',
      before: 100
    }
  ];

  it('shows under a setting the Admiral changed last, with why and Undo', () => {
    const html = renderToStaticMarkup(
      createElement(AdmiralChangeNote, { marks, settingKey: 'agency.admiral.monthlyCapUsd' })
    );
    expect(html).toContain('title="Cheaper jobs."');
    expect(html).toContain('Changed by the Admiral');
    expect(html).toContain('title="Back to 100"');
    expect(html).toContain('>Undo<');
  });

  it('shows nothing under a setting it did not change', () => {
    expect(
      renderToStaticMarkup(
        createElement(AdmiralChangeNote, { marks, settingKey: 'agency.admiral.defaultBudgetUsd' })
      )
    ).toBe('');
  });
});
