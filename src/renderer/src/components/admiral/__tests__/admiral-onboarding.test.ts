import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyPreflight } from '../../../../../shared/agency';
import type { BriefIdeas, ProjectFolder } from '../../../../../shared/agency-projects';
import { admiralStage } from '../admiral-stage';
import { FirstRunView, type FirstRunViewProps } from '../FirstRunView';
import { BriefIdeasList } from '../EmptyBrief';
import { cloneSlug, folderBadges, pickBlocker, projectStatus } from '../onboarding-view';
import { ProjectRow } from '../ProjectPicker';
import { ClientFilePreview } from '../StarterQuestions';

/** The Admiral's onboarding: which screen shows, first run's gate, and the picker's rows. */

const done = { setupDoneAt: 1, starterDoneAt: 2 };
const base = {
  keyChecked: true,
  hasModel: true,
  firstRunDone: true,
  picking: false,
  onboarding: done
};

describe('admiralStage', () => {
  it('holds every screen until it knows whether there is a model and first run was done', () => {
    expect(admiralStage({ ...base, keyChecked: false })).toBe('loading');
    expect(admiralStage({ ...base, firstRunDone: null })).toBe('loading');
  });

  it('shows first run without a model, even after first run was finished once', () => {
    expect(admiralStage({ ...base, hasModel: false })).toBe('first-run');
    expect(admiralStage({ ...base, firstRunDone: false })).toBe('first-run');
    expect(admiralStage({ ...base, hasModel: false, picking: true })).toBe('first-run');
  });

  it('then the picker when asked for, then setup, the starter questions and the lobby', () => {
    expect(admiralStage({ ...base, picking: true })).toBe('picker');
    expect(admiralStage({ ...base, onboarding: undefined })).toBe('loading');
    expect(admiralStage({ ...base, onboarding: { setupDoneAt: null, starterDoneAt: null } })).toBe(
      'setup'
    );
    expect(admiralStage({ ...base, onboarding: { setupDoneAt: 1, starterDoneAt: null } })).toBe(
      'starter'
    );
    expect(admiralStage(base)).toBe('ready');
  });
});

const PREFLIGHT: AgencyPreflight = {
  modelKey: true,
  claude: { found: true, version: '2.3.4' },
  eva: { found: false, version: null },
  gh: { found: true, signedIn: false }
};

const noop = (): void => {};
function firstRun(over: Partial<FirstRunViewProps>): string {
  return renderToStaticMarkup(
    createElement(FirstRunView, {
      preflight: PREFLIGHT,
      checking: false,
      model: { kind: 'none' },
      ghSkipped: false,
      onSaveKey: async () => Promise.resolve(),
      onUseLocal: noop,
      onChangeModel: noop,
      onGhLogin: noop,
      onCheckAgain: noop,
      onSkipGh: noop,
      onPick: noop,
      ...over
    })
  );
}

/** The "Pick a project" button's opening tag. */
const pickButton = (html: string): string =>
  /<button[^>]*>Pick a project<\/button>/.exec(html)?.[0] ?? '';

describe('first run', () => {
  it('keeps "Pick a project" disabled until a model key is saved', () => {
    const html = firstRun({ model: { kind: 'none' } });
    expect(pickButton(html)).toContain('disabled=""');
    expect(html).toContain('Save the Admiral’s model key to go on.');
    expect(html).toContain('aria-label="OpenRouter key"');
    expect(html).toContain('Use a local model');
  });

  it('opens it once the key is in, and says where the key is', () => {
    const html = firstRun({ model: { kind: 'openrouter', model: 'anthropic/claude-sonnet-4.5' } });
    expect(pickButton(html)).not.toContain('disabled=""');
    expect(html).toContain('key in Keychain');
    expect(html).toContain('anthropic/claude-sonnet-4.5');
    expect(html).not.toContain('aria-label="OpenRouter key"');
  });

  it('counts a local model as a model', () => {
    expect(pickBlocker(PREFLIGHT, { kind: 'local', model: 'qwen3' })).toBeNull();
  });

  it('needs a crew runtime too, and links to how to install one', () => {
    const none = { ...PREFLIGHT, claude: { found: false, version: null } };
    const html = firstRun({ preflight: none, model: { kind: 'openrouter', model: '' } });
    expect(pickButton(html)).toContain('disabled=""');
    expect(html).toContain('Install Claude Code or eva so the crew can run.');
    expect(html).toContain('How to install');
    expect(pickBlocker(null, { kind: 'openrouter', model: '' })).toBe('Checking this Mac…');
  });

  it('shows the crew it found with versions, and offers gh auth login, Check again and Skip', () => {
    const html = firstRun({ model: { kind: 'openrouter', model: '' } });
    expect(html).toContain('2.3.4');
    expect(html).toContain('not installed · optional, cheaper for bulk work');
    expect(html).toContain('Run gh auth login');
    expect(html).toContain('Check again');
    expect(html).toContain('Skip for now');
    expect(firstRun({ ghSkipped: true })).not.toContain('Skip for now');
  });

  it('has no sign-in buttons once the GitHub CLI is signed in', () => {
    const html = firstRun({ preflight: { ...PREFLIGHT, gh: { found: true, signedIn: true } } });
    expect(html).toContain('The GitHub CLI is signed in.');
    expect(html).not.toContain('Run gh auth login');
  });
});

const REPO_FOLDER: Extract<ProjectFolder, { kind: 'repo' }> = {
  path: '/home/k/dev/notebook',
  kind: 'repo',
  repo: { repoId: '0123456789abcdef', root: '/home/k/dev/notebook', name: 'notebook' },
  branch: 'main',
  remote: null,
  teamFiles: false,
  setupDone: false
};

const row = (folder: ProjectFolder, admiralOpen = false): string =>
  renderToStaticMarkup(
    createElement(ProjectRow, {
      folder,
      selected: false,
      admiralOpen,
      home: '/home/k',
      onSelect: noop
    })
  );

describe('project picker rows', () => {
  it('shows a folder that is not a repository, and does not let it be picked', () => {
    const html = row({ path: '/home/k/Downloads', kind: 'not-a-repo' });
    expect(html).toContain('Not a git repository');
    expect(html).toContain('~/Downloads');
    expect(html).toMatch(/<button[^>]* disabled=""/);
  });

  it('says a repository with no remote leaves local branches', () => {
    const html = row(REPO_FOLDER);
    expect(html).toContain('~/dev/notebook · main · no remote');
    expect(html).toContain('Local branches only');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('leads with what matters most: set up, team files, no remote, or not set up', () => {
    const labels = (f: ProjectFolder, open = false): string[] =>
      folderBadges(f, open).map((b) => b.label);
    const github = { ...REPO_FOLDER, remote: 'github.com/acme/shop' };
    expect(labels(github)).toEqual(['Needs setup']);
    expect(labels({ ...github, teamFiles: true })).toEqual(['Has team files to import']);
    expect(labels({ ...github, teamFiles: true, setupDone: true }, true)).toEqual([
      'Admiral open',
      'Set up'
    ]);
  });
});

describe('the rest of onboarding', () => {
  it('reads a pasted GitHub repository in any of its usual forms', () => {
    expect(cloneSlug('acme/shop')).toBe('acme/shop');
    expect(cloneSlug('https://github.com/acme/shop.git')).toBe('acme/shop');
    expect(cloneSlug('git@github.com:acme/shop.git')).toBe('acme/shop');
    expect(cloneSlug('https://gitlab.com/acme/shop')).toBeNull();
    expect(cloneSlug('shop')).toBeNull();
  });

  it('says in the switcher what a project is waiting on', () => {
    const p = {
      repo: REPO_FOLDER.repo,
      setupDoneAt: null,
      starterDoneAt: null,
      runningJobs: 0,
      openQuestions: 0
    };
    expect(projectStatus(p)).toBe('not set up');
    expect(projectStatus({ ...p, setupDoneAt: 1 })).toBe('setup unfinished');
    expect(projectStatus({ ...p, runningJobs: 2, openQuestions: 1 })).toBe(
      '1 question · 2 jobs running'
    );
  });

  it('lists brief ideas as chips, and says why GitHub ones are missing', () => {
    const ideas: BriefIdeas = {
      github: 'signed-out',
      ideas: [{ kind: 'changelog', tag: 'Changelog', title: 'Follow up on v2', brief: 'x' }]
    };
    const html = renderToStaticMarkup(createElement(BriefIdeasList, { ideas, onPick: noop }));
    expect(html).toContain('Changelog');
    expect(html).toContain('Follow up on v2');
    expect(html).toContain('Sign in to the GitHub CLI');
    const empty = renderToStaticMarkup(
      createElement(BriefIdeasList, { ideas: { ideas: [], github: 'ok' }, onPick: noop })
    );
    expect(empty).toContain('Describe the work in your own words.');
  });

  it('shows each client file line with its source', () => {
    const html = renderToStaticMarkup(
      createElement(ClientFilePreview, {
        text: '# shop\n- Use pnpm. (from CLAUDE.md, 2026-10-17)\n',
        path: null
      })
    );
    expect(html).toContain('- Use pnpm.');
    // The date is kept on one line in its own span, so compare the text.
    expect(html.replace(/<[^>]+>/g, '')).toContain('(from CLAUDE.md, 2026-10-17)');
  });
});
