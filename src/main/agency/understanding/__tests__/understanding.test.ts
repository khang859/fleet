import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_AGENCY_SETTINGS, type AgencySettings } from '../../../../shared/agency';
import { YOU_LAYER } from '../../../../shared/agency-client-file';
import type { ReadProposal } from '../../../../shared/agency-understanding';
import { ENV_MASK, Redactor } from '../../../redactor';
import { storeFixture } from '../../__tests__/fixture';
import { ClientFiles, ruleCandidates } from '../../projects/client-file';
import type { GhRun } from '../../projects/gh';
import { fakeGh, git, initRepo, tempDir, writeFiles } from '../../projects/__tests__/git-fixture';
import { readOnlyGit } from '../../projects/repo-reader';
import { SpendService } from '../../spend/spend-service';
import type { AgencyStore } from '../../store/agency-store';
import { Understanding, type AdmiralCompletion } from '../index';

const ENV_VALUE = 'postgres://admin:hunter2-prod@db.internal/app';
const TOKEN = `ghp_${'A1b2C3d4'.repeat(5)}`;

let dir: string;
let cleanupDir: () => void;
let store: AgencyStore;
let cleanupStore: () => void;
let clock: { now: number };
let settings: AgencySettings['admiral'];
let files: ClientFiles;
let root: string;
let repo: { repoId: string; root: string; name: string };
let gh: GhRun;
let complete: ReturnType<typeof vi.fn<AdmiralCompletion>>;
let understanding: Understanding;

const answer = (lines: unknown[]): string => JSON.stringify({ lines });

/** A line as the model writes it. */
const said = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  text: 'Use a scope in every commit message.',
  layer: 'project',
  source: 'your commits',
  evidence: 'All 3 commits have one.',
  clashesWith: null,
  ...over
});

const line = (over: Partial<ReadProposal> = {}): ReadProposal => ({
  text: 'Use a scope in every commit message.',
  layer: 'project',
  source: 'your commits',
  evidence: 'All 3 commits have one.',
  ...over
});

beforeEach(() => {
  ({ dir, cleanup: cleanupDir } = tempDir('fleet-understand-'));
  ({ store, clock, cleanup: cleanupStore } = storeFixture());
  settings = { ...DEFAULT_AGENCY_SETTINGS.admiral };
  root = initRepo(
    join(dir, 'repo'),
    { 'CLAUDE.md': '- Update docs with every user-facing change.\n' },
    { origin: 'https://github.com/acme/fleet.git' }
  );
  git(root, 'config', 'user.email', 'test@example.com');
  writeFiles(root, { 'a.txt': 'a' });
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `fix(auth): rotate ${TOKEN}`, '-m', `db at ${ENV_VALUE}`);
  repo = { repoId: '0123456789abcdef', root, name: 'fleet' };
  files = new ClientFiles({ store, home: () => join(dir, 'agency') });
  gh = fakeGh((args) => (args[0] === 'auth' ? { code: 1, stdout: '' } : null));
  complete = vi.fn<AdmiralCompletion>(async () =>
    Promise.resolve({ text: answer([]), costUsd: 0.02, cutOff: false })
  );
  const spend = new SpendService({
    store,
    settings: () => settings,
    changed: () => {},
    now: () => clock.now,
    working: () => false,
    admitQueued: () => {}
  });
  understanding = new Understanding({
    store,
    clientFiles: files,
    spend,
    git: readOnlyGit,
    gh: async (args, cwd) => gh(args, cwd),
    userHome: join(dir, 'home'),
    root: async () => Promise.resolve(root),
    rules: async () => ruleCandidates(root),
    redactor: async () => Promise.resolve(new Redactor([ENV_VALUE])),
    complete,
    emit: () => {}
  });
});

afterEach(() => {
  cleanupStore();
  cleanupDir();
});

const spentUsd = (): number => store.spend.usdSince(0);

describe('sources', () => {
  it('shows the GitHub sources as unavailable without a GitHub sign-in, and the rest as ready', async () => {
    const sources = await understanding.sources(repo);
    expect(sources.map((s) => [s.id, s.available, s.detail])).toEqual([
      ['instructions', true, 'CLAUDE.md'],
      ['commits', true, 'Commits by test@example.com.'],
      ['reviews', false, 'Sign in to the GitHub CLI to read this.'],
      ['prs', false, 'Sign in to the GitHub CLI to read this.'],
      ['jobs', false, 'No past job here has your answers yet.']
    ]);
  });

  it('counts the client’s own instruction file once it is there', async () => {
    writeFiles(join(dir, 'home'), { '.claude/CLAUDE.md': '- Be brief.\n' });
    const [instructions] = await understanding.sources(repo);
    expect(instructions.detail).toBe('CLAUDE.md and your ~/.claude/CLAUDE.md');
  });

  it('names the client’s own file alone when the project has no rule file', async () => {
    writeFiles(join(dir, 'home'), { '.claude/CLAUDE.md': '- Be brief.\n' });
    git(root, 'rm', '-q', 'CLAUDE.md');
    git(root, 'commit', '-q', '-m', 'chore: drop rules');
    const [instructions] = await understanding.sources(repo);
    expect(instructions.detail).toBe('Your ~/.claude/CLAUDE.md');
  });
});

describe('read', () => {
  it('sends nothing when nothing is ticked', async () => {
    expect(await understanding.read(repo, [])).toEqual({
      ok: false,
      reason: 'Tick at least one thing I may read.'
    });
    expect(complete).not.toHaveBeenCalled();
  });

  it('masks a planted token and an env value before the text leaves', async () => {
    await understanding.read(repo, ['commits']);
    const sent = complete.mock.calls[0][0].user;
    expect(sent).toContain('fix(auth): rotate');
    expect(sent).not.toContain(TOKEN);
    expect(sent).not.toContain(ENV_VALUE);
    expect(sent).toContain(ENV_MASK);
  });

  it('reads only what was ticked', async () => {
    writeFiles(join(dir, 'home'), { '.claude/CLAUDE.md': '- Be brief.\n' });
    await understanding.read(repo, ['commits']);
    const sent = complete.mock.calls[0][0].user;
    expect(sent).toContain('<<<source: your commits>>>');
    expect(sent).not.toContain('Be brief');
    expect(sent).not.toContain('<<<source: CLAUDE.md>>>');
  });

  it('keeps good lines, and drops saved, unread and repeated ones and one a project rule goes against', async () => {
    files.merge(repo.repoId, {
      name: 'fleet',
      lines: [{ text: 'Open PRs as drafts.', source: 'you' }]
    });
    complete.mockResolvedValue({
      text: `Here you go:\n\`\`\`json\n${answer([
        said(),
        said({ text: 'open PRs as drafts' }),
        said({ text: 'Use a scope in every commit message' }),
        said({ text: 'Merge on green.', source: 'your PR descriptions' }),
        said({
          text: 'Skip docs unless asked.',
          source: 'CLAUDE.md',
          clashesWith: { source: 'CLAUDE.md', rule: 'update docs with every user-facing change.' }
        }),
        said({
          text: 'Ship on Fridays.',
          clashesWith: { source: 'CLAUDE.md', rule: 'A rule that is not there.' }
        }),
        said({ layer: undefined, text: 'No layer.' })
      ])}\n\`\`\``,
      costUsd: 0.02,
      cutOff: false
    });
    const result = await understanding.read(repo, ['commits', 'instructions']);
    expect(result).toEqual({
      ok: true,
      lines: [line(), line({ text: 'Ship on Fridays.' })]
    });
    expect(complete.mock.calls[0][0].user).toContain('- Open PRs as drafts.');
    expect(spentUsd()).toBeCloseTo(0.02);
    expect(store.spend.reserved('usd', null)).toBe(0);
  });

  it('refuses an answer that is not the JSON asked for, and still counts its cost', async () => {
    complete.mockResolvedValue({
      text: 'Sorry, I cannot help with that.',
      costUsd: 0.01,
      cutOff: false
    });
    const result = await understanding.read(repo, ['commits']);
    expect(result).toEqual({
      ok: false,
      reason: "The Admiral's model sent back something Fleet could not read. Try again."
    });
    expect(spentUsd()).toBeCloseTo(0.01);
  });

  it('says so when thinking used up the limit and the answer was cut off', async () => {
    complete.mockResolvedValue({ text: '{"lines": [{"text": "Open', costUsd: 0.01, cutOff: true });
    const result = await understanding.read(repo, ['commits']);
    expect(!result.ok && result.reason).toContain('ran out of room');
  });

  it('refuses at the monthly cap without calling the model', async () => {
    settings.monthlyCapUsd = 1;
    store.spend.record({ jobId: null, crewId: null, source: 'admiral', meter: 'usd', amount: 1 });
    const result = await understanding.read(repo, ['commits']);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain('monthly cap');
    expect(complete).not.toHaveBeenCalled();
  });

  it('says so when the model call fails, and holds nothing back', async () => {
    complete.mockRejectedValue(new Error('401 Unauthorized'));
    const result = await understanding.read(repo, ['commits']);
    expect(!result.ok && result.reason).toBe(
      "The Admiral's model did not answer: Error: 401 Unauthorized"
    );
    expect(store.spend.reserved('usd', null)).toBe(0);
  });

  it('reads review comments and PR descriptions once the GitHub CLI is signed in', async () => {
    gh = fakeGh((args) => {
      if (args[0] === 'auth') return { code: 0, stdout: '' };
      if (args[1] === 'user') return { code: 0, stdout: 'octo' };
      if (args[0] === 'pr') return { code: 0, stdout: '[{"title":"Add it","body":"Why."}]' };
      return { code: 0, stdout: '{"data":{"search":{"nodes":[]}}}' };
    });
    await understanding.read(repo, ['reviews', 'prs']);
    const sent = complete.mock.calls[0][0].user;
    expect(sent).toContain('<<<source: your PR descriptions>>>\n1. Add it\n\nWhy.');
    expect(sent).not.toContain('your review comments>>>');
  });
});

describe('keep and conflicts', () => {
  const RULE = 'Update docs with every user-facing change.';
  const clash = line({ text: 'Skip docs unless asked.', source: 'CLAUDE.md' });

  /** A saved line with a clash still open from before the rule won on its own. */
  function clashing(): void {
    understanding.keep(repo, [clash]);
    store.preferences.openConflict({
      layer: repo.repoId,
      text: clash.text,
      ruleSource: 'CLAUDE.md',
      ruleText: RULE
    });
  }

  it('saves only kept lines, each tagged with its source, on its layer', () => {
    expect(
      understanding.keep(repo, [
        line(),
        line({ text: 'Be brief.', layer: 'you', source: 'your CLAUDE.md' })
      ])
    ).toEqual({ ok: true });
    expect(files.read(repo.repoId)).toMatch(
      /- Use a scope in every commit message\. \(from your commits, \d{4}-\d{2}-\d{2}\)/
    );
    expect(files.read(YOU_LAYER)).toMatch(/- Be brief\. \(from your CLAUDE\.md, /);
    expect(store.preferences.conflicts(repo.repoId)).toEqual([]);
  });

  it('removes the line when the rule wins', () => {
    clashing();
    understanding.keep(repo, [line()]);
    const [c] = store.preferences.conflicts(repo.repoId);
    expect(
      understanding.settle({ repoId: repo.repoId, layer: repo.repoId, id: c.id, winner: 'rule' })
    ).toEqual({ ok: true });
    expect(files.read(repo.repoId)).not.toContain('Skip docs');
    expect(files.read(repo.repoId)).toContain('Use a scope');
    expect(store.preferences.conflicts(repo.repoId)).toEqual([]);
  });

  it('marks the line as overriding the rule in the note when the line wins', () => {
    clashing();
    expect(files.forNote(repo.repoId)?.text).not.toContain('overrides');
    const [c] = store.preferences.conflicts(repo.repoId);
    understanding.settle({ repoId: repo.repoId, layer: repo.repoId, id: c.id, winner: 'line' });
    expect(files.forNote(repo.repoId)?.text).toMatch(
      /^P1\. Skip docs unless asked\. \(from CLAUDE\.md, [\d-]+\) \(overrides CLAUDE\.md\)$/
    );
    expect(
      understanding.settle({ repoId: repo.repoId, layer: repo.repoId, id: c.id, winner: 'rule' })
    ).toEqual({ ok: false, reason: 'That clash is settled already.' });
  });

  it('refuses to save while the layer changed outside Fleet', () => {
    files.merge(repo.repoId, { name: 'fleet', lines: [] });
    writeFileSync(files.path(repo.repoId), '# fleet\n- typed by hand\n');
    expect(understanding.keep(repo, [line()]).ok).toBe(false);
  });
});
