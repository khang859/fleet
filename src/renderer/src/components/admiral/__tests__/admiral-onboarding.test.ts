import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyPreflight } from '../../../../../shared/agency';
import type {
  BriefIdeas,
  ProjectFolder,
  ProjectMemberSetup,
  SetupScan,
  WorkspaceMember
} from '../../../../../shared/agency-projects';
import { admiralStage } from '../admiral-stage';
import { FirstRunView, type FirstRunViewProps } from '../FirstRunView';
import { BriefIdeasList } from '../EmptyBrief';
import {
  cloneSlug,
  folderBadges,
  memberOrder,
  pickBlocker,
  projectStatus,
  repoNotes,
  runsServers,
  serversNote,
  stackSlotsLabel
} from '../onboarding-view';
import { MemberList, ProjectRow } from '../ProjectPicker';
import { MissingCard } from '../MissingCard';

/** The Admiral's onboarding: which screen shows, first run's gate, and the picker's rows. */

const done = { setupDoneAt: 1, starterDoneAt: 2, meetDue: false, meetLeft: [] };
const base = {
  keyChecked: true,
  hasModel: true,
  firstRunDone: true,
  picking: false,
  redoingSetup: false,
  meeting: false,
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

  it('then the picker when asked for, then setup, Meet you and the lobby', () => {
    const due = { ...done, meetDue: true };
    expect(admiralStage({ ...base, picking: true })).toBe('picker');
    expect(admiralStage({ ...base, onboarding: undefined })).toBe('loading');
    expect(
      admiralStage({ ...base, onboarding: { ...due, setupDoneAt: null, starterDoneAt: null } })
    ).toBe('setup');
    expect(admiralStage({ ...base, onboarding: { ...due, starterDoneAt: null } })).toBe('meet');
    expect(admiralStage({ ...base, onboarding: due })).toBe('meet');
    expect(admiralStage(base)).toBe('ready');
  });

  it('shows Meet you again when the client goes back to the questions left', () => {
    expect(admiralStage({ ...base, meeting: true })).toBe('meet');
    expect(admiralStage({ ...base, meeting: true, picking: true })).toBe('picker');
  });

  it('shows setup again when the client redoes it, but the picker first', () => {
    expect(admiralStage({ ...base, redoingSetup: true })).toBe('setup');
    expect(admiralStage({ ...base, redoingSetup: true, picking: true })).toBe('picker');
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

const member = (name: string): WorkspaceMember => ({
  name,
  path: `libs/${name}`,
  repo: {
    repoId: `${name}0000000000000`.slice(0, 16),
    root: `/home/k/dev/shop/libs/${name}`,
    name
  },
  branch: 'main',
  remote: `github.com/acme/${name}`,
  umbrella: false,
  leftOut: false
});

const WORKSPACE: Extract<ProjectFolder, { kind: 'workspace' }> = {
  path: '/home/k/dev/shop',
  kind: 'workspace',
  project: { repoId: 'aaaaaaaaaaaaaaaa', root: '/home/k/dev/shop', name: 'shop' },
  projectKind: 'submodules',
  members: [
    member('core'),
    { ...member('api'), repo: null, branch: null, remote: null },
    { ...member('web'), leftOut: true },
    { ...member('shop'), path: '.', umbrella: true }
  ],
  teamFiles: false,
  setupDone: false
};

describe('workspace projects in the picker', () => {
  it('shows a workspace as one row with its member count', () => {
    const html = row(WORKSPACE);
    expect(html).toContain('>shop<');
    expect(html).toContain('>~/dev/shop<');
    expect(html).toContain('>3 submodules<');
    expect(html).toContain('Needs setup');
    expect(html).not.toMatch(/<button[^>]* disabled=""/);
  });

  it('lists members with a box each, the umbrella always kept and a missing one marked', () => {
    const html = renderToStaticMarkup(
      createElement(MemberList, {
        folder: WORKSPACE,
        leftOut: ['web'],
        home: '/home/k',
        onToggle: noop
      })
    );
    expect(html).toContain('3 of 4 in the project');
    const box = (name: string): string =>
      new RegExp(`<input[^>]*Keep ${name} in the project[^>]*>`).exec(html)?.[0] ?? '';
    expect(box('web')).not.toContain('checked');
    expect(box('core')).toContain('checked=""');
    expect(box('shop')).toContain('checked=""');
    expect(box('shop')).toContain('disabled=""');
    expect(html).toContain('Missing');
    expect(html).toContain('~/dev/shop · main');
    expect(html).toContain('libs/core · main · github.com/acme/core');
  });

  it('says a workspace has local branches only when no member has a remote', () => {
    const local = { ...WORKSPACE, members: WORKSPACE.members.map((m) => ({ ...m, remote: null })) };
    expect(folderBadges(local, false).map((b) => b.label)).toEqual(['Local branches only']);
  });
});

describe('workspace setup', () => {
  const setupMember = (name: string, path: string): ProjectMemberSetup => ({
    name,
    path,
    remote: null,
    defaultBranch: 'main',
    stack: [],
    packageManager: null,
    setupCommand: '',
    setupTimeoutSec: 600,
    checkCommands: [],
    checks: [],
    requiredChecks: [],
    reviewBots: [],
    portVars: [],
    fixedPorts: [],
    envFiles: []
  });
  const members = [setupMember('core', 'libs/core'), setupMember('shop', '.')];
  const scan: SetupScan = {
    repo: WORKSPACE.project,
    kind: 'submodules',
    setup: {
      version: 1,
      kind: 'submodules',
      name: 'shop',
      members,
      imports: [],
      setupCommand: '',
      setupTimeoutSec: 600,
      stackSlots: null
    },
    saved: false,
    newer: [],
    members: members.map((m) => ({
      name: m.name,
      path: m.path,
      readFrom: 'main',
      requiredChecksFrom: 'no-github' as const
    })),
    missing: [{ name: 'api', path: 'libs/api' }],
    repoFiles: [],
    envFiles: [],
    teamSetup: {
      version: 1,
      kind: 'submodules',
      name: 'shop',
      members,
      imports: [],
      setupCommand: '',
      setupTimeoutSec: 600,
      stackSlots: null
    },
    ghSignedIn: false
  };

  it('names the member order, dependencies first', () => {
    expect(memberOrder(scan.setup)).toBe('core → shop');
  });

  it('says a teammate shared a setup once, on the umbrella', () => {
    const shared = (i: number): boolean =>
      repoNotes(scan, members[i], scan.members[i]).some((n) => n.text.includes('teammate'));
    expect([shared(0), shared(1)]).toEqual([false, true]);
  });

  it('offers to check out a submodule setup could not read', () => {
    const html = renderToStaticMarkup(
      createElement(MissingCard, { repo: WORKSPACE.project, scan, onCheckedOut: noop })
    );
    expect(html).toContain('NOT CHECKED OUT');
    expect(html).toContain('libs/api');
    expect(html).toContain('>Check out<');
  });

  it('shows the servers card only for a project with ports or a stack limit, and says why', () => {
    expect(runsServers(scan.setup)).toBe(false);
    const postgres = { port: 5432, service: 'postgres' };
    const withPorts = {
      ...scan.setup,
      members: [{ ...members[0], portVars: ['API_PORT'], fixedPorts: [postgres] }, members[1]],
      stackSlots: 1
    };
    expect(runsServers(withPorts)).toBe(true);
    expect(runsServers({ ...scan.setup, stackSlots: 2 })).toBe(true);
    expect(stackSlotsLabel(1)).toBe('1 · one stack runs at a time');
    expect(stackSlotsLabel(null)).toBe('No limit');
    expect(serversNote([postgres])).toContain('postgres on 5432 cannot move');
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
});
