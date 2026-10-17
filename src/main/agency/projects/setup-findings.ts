import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgencyRepoRef } from '../../../shared/agency';
import {
  githubSlug,
  type ProjectMemberSetup,
  type ProjectSetup,
  type RepoFile,
  type RequiredChecksSource,
  type SetupScan
} from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { ghJson, ghState, type GhRun } from './gh';
import { parseSetupToml } from './project-store';
import { openRepoReader, readOnlyGit, repoFacts, type RepoReader } from './repo-reader';

/**
 * Project setup's scan: what a repository is built with, how a fresh worktree
 * gets ready, which checks it has, and which crew files it carries.
 *
 * Read-only and deterministic. It reads the default branch tip out of git's
 * object store, so nothing is checked out and the working tree is not
 * touched; it runs `git` for reading and `gh` for GitHub's view, and never a
 * command the repository defines. No pane, worktree or branch comes of it.
 */

export type ScanDeps = { git?: GitRun; gh?: GhRun };

/** How long a fresh worktree's setup may take before crew give up on it. */
export const DEFAULT_SETUP_TIMEOUT_SEC = 600;

type Stack = {
  stack: string[];
  packageManager: string | null;
  setupCommand: string;
  checkCommands: string[];
};

const PackageJson = z
  .object({
    packageManager: z.string().optional(),
    scripts: z.record(z.string(), z.string()).optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    devDependencies: z.record(z.string(), z.string()).optional()
  })
  .loose();
type PackageJson = z.infer<typeof PackageJson>;

/** Frameworks by the package that gives them away, most specific first. */
const FRAMEWORKS: ReadonlyArray<[string, string]> = [
  ['next', 'Next.js'],
  ['@nestjs/core', 'NestJS'],
  ['@sveltejs/kit', 'SvelteKit'],
  ['astro', 'Astro'],
  ['@remix-run/react', 'Remix'],
  ['electron', 'Electron'],
  ['nuxt', 'Nuxt'],
  ['react', 'React'],
  ['vue', 'Vue'],
  ['svelte', 'Svelte'],
  ['express', 'Express'],
  ['fastify', 'Fastify']
];

/** Scripts crew run to check their work, in the order they are worth running. */
const CHECK_SCRIPTS = ['typecheck', 'lint', 'test', 'check'];

/** Scripts a repository keeps for getting a new worktree ready. */
const WORKTREE_SCRIPTS = [
  'scripts/wt-setup.sh',
  'scripts/worktree-setup.sh',
  'bin/setup',
  'script/setup'
];

function nodePackageManager(pkg: PackageJson, has: (path: string) => boolean): string {
  const declared = /^(pnpm|yarn|npm|bun)@/.exec(pkg.packageManager ?? '')?.[1];
  if (declared) return declared;
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lock') || has('bun.lockb')) return 'bun';
  return 'npm';
}

function nodeInstall(pm: string, has: (path: string) => boolean): string {
  switch (pm) {
    case 'pnpm':
      return 'pnpm install --frozen-lockfile';
    case 'yarn':
      return has('.yarnrc.yml') ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
    case 'bun':
      return 'bun install --frozen-lockfile';
    default:
      return has('package-lock.json') ? 'npm ci' : 'npm install';
  }
}

function runScript(pm: string, script: string): string {
  if (pm === 'npm') return script === 'test' ? 'npm test' : `npm run ${script}`;
  return `${pm} run ${script}`;
}

async function nodeStack(
  reader: RepoReader,
  has: (path: string) => boolean
): Promise<Stack | null> {
  const text = await reader.read('package.json');
  if (text === null) return null;
  let pkg: PackageJson;
  try {
    pkg = PackageJson.parse(JSON.parse(text));
  } catch {
    pkg = {};
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const stack = FRAMEWORKS.filter(([dep]) => dep in deps).map(([, label]) => label);
  // React under Next.js, Remix or Electron goes without saying.
  const frameworks =
    stack.includes('Next.js') || stack.includes('Remix')
      ? stack.filter((s) => s !== 'React')
      : stack;
  if ('typescript' in deps || has('tsconfig.json')) frameworks.push('TypeScript');
  if (frameworks.length === 0) frameworks.push('Node.js');
  const pm = nodePackageManager(pkg, has);
  const scripts = pkg.scripts ?? {};
  return {
    stack: frameworks,
    packageManager: pm,
    setupCommand: nodeInstall(pm, has),
    checkCommands: CHECK_SCRIPTS.filter((s) => s in scripts).map((s) => runScript(pm, s))
  };
}

/** Stacks known by one marker file, for repositories that are not Node. */
function otherStack(has: (path: string) => boolean): Stack | null {
  if (has('go.mod')) {
    return {
      stack: ['Go'],
      packageManager: 'go',
      setupCommand: 'go mod download',
      checkCommands: ['go vet ./...', 'go test ./...']
    };
  }
  if (has('Cargo.toml')) {
    return {
      stack: ['Rust'],
      packageManager: 'cargo',
      setupCommand: 'cargo fetch',
      checkCommands: ['cargo test']
    };
  }
  if (has('pyproject.toml') || has('requirements.txt')) {
    const pm = has('uv.lock') ? 'uv' : has('poetry.lock') ? 'poetry' : 'pip';
    const setup =
      pm === 'uv'
        ? 'uv sync'
        : pm === 'poetry'
          ? 'poetry install'
          : 'pip install -r requirements.txt';
    return { stack: ['Python'], packageManager: pm, setupCommand: setup, checkCommands: [] };
  }
  if (has('Gemfile')) {
    return {
      stack: ['Ruby'],
      packageManager: 'bundler',
      setupCommand: 'bundle install',
      checkCommands: []
    };
  }
  return null;
}

const Workflow = z
  .object({
    jobs: z.record(z.string(), z.object({ name: z.unknown().optional() }).loose()).optional()
  })
  .loose();

/**
 * The CI checks a pull request gets: each job in each GitHub Actions workflow,
 * named as GitHub names its check (the job's `name`, else its id). A name
 * built from an expression is only known at run time, so the id stands in.
 */
async function ciChecks(reader: RepoReader): Promise<string[]> {
  const files = reader
    .list('.github/workflows')
    .filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f))
    .sort();
  const checks: string[] = [];
  for (const file of files) {
    const text = await reader.read(file);
    if (text === null) continue;
    let parsed: z.infer<typeof Workflow>;
    try {
      parsed = Workflow.parse(parseYaml(text));
    } catch {
      continue;
    }
    for (const [id, job] of Object.entries(parsed.jobs ?? {})) {
      const name = typeof job.name === 'string' && !job.name.includes('${{') ? job.name : id;
      if (!checks.includes(name)) checks.push(name);
    }
  }
  return checks;
}

const ProtectionChecks = z.object({
  contexts: z.array(z.string()).optional(),
  checks: z.array(z.object({ context: z.string() })).optional()
});
const BranchRules = z.array(
  z.object({
    type: z.string(),
    parameters: z
      .object({ required_status_checks: z.array(z.object({ context: z.string() })).optional() })
      .loose()
      .optional()
  })
);

/**
 * The checks the default branch requires, from classic branch protection and
 * from rulesets. Neither is readable without the GitHub CLI signed in; a
 * branch with neither simply requires none.
 */
async function requiredChecks(
  gh: GhRun,
  root: string,
  slug: string,
  branch: string
): Promise<string[]> {
  const found = new Set<string>();
  const branchPath = encodeURIComponent(branch);
  const classic = ProtectionChecks.safeParse(
    ghJson(
      await gh(
        ['api', `repos/${slug}/branches/${branchPath}/protection/required_status_checks`],
        root
      )
    )
  );
  if (classic.success) {
    for (const c of classic.data.contexts ?? []) found.add(c);
    for (const c of classic.data.checks ?? []) found.add(c.context);
  }
  const rules = BranchRules.safeParse(
    ghJson(await gh(['api', `repos/${slug}/rules/branches/${branchPath}`], root))
  );
  if (rules.success) {
    for (const rule of rules.data) {
      if (rule.type !== 'required_status_checks') continue;
      for (const c of rule.parameters?.required_status_checks ?? []) found.add(c.context);
    }
  }
  return [...found];
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** What a file under the repository is, for the setup screen. */
function classify(path: string): Omit<RepoFile, 'sha256'> | null {
  if (path === '.fleet/fleet.agency.toml')
    return { path, kind: 'setup', disposition: 'importable' };
  if (/^\.fleet\/crew\/roles\/[^/]+\.md$/.test(path))
    return { path, kind: 'role', disposition: 'importable' };
  if (/^\.fleet\/crew\/playbooks\/[^/]+\.md$/.test(path)) {
    return { path, kind: 'playbook', disposition: 'importable' };
  }
  if (path.startsWith('.fleet/')) return { path, kind: 'other', disposition: 'not-used' };
  if (/^\.(claude|opencode)\/agents\/[^/]+\.md$/.test(path)) {
    return { path, kind: 'agent', disposition: 'importable' };
  }
  if (/^\.claude\/skills\/[^/]+\/SKILL\.md$/.test(path)) {
    return { path: path.replace(/\/SKILL\.md$/, ''), kind: 'skill', disposition: 'in-place' };
  }
  if (path === 'CLAUDE.md' || path === 'AGENTS.md') {
    return { path, kind: 'instructions', disposition: 'in-place' };
  }
  return null;
}

async function repoFiles(reader: RepoReader): Promise<RepoFile[]> {
  const out: RepoFile[] = [];
  for (const path of reader.list('')) {
    const file = classify(path);
    if (file === null) continue;
    const text = file.disposition === 'importable' ? await reader.read(path) : null;
    out.push({ ...file, sha256: text === null ? null : sha256(text) });
  }
  return out;
}

/** The stack, its setup and its checks, from whichever marker files the repository has. */
async function detectStack(reader: RepoReader): Promise<Stack> {
  const all = new Set(reader.list(''));
  const has = (path: string): boolean => all.has(path);
  const stack = (await nodeStack(reader, has)) ??
    otherStack(has) ?? { stack: [], packageManager: null, setupCommand: '', checkCommands: [] };
  const script = WORKTREE_SCRIPTS.find(has);
  return script === undefined ? stack : { ...stack, setupCommand: `./${script}` };
}

/** Scan a repository for setup. See the module comment for what it may and may not do. */
export async function scanProject(
  repo: AgencyRepoRef,
  deps: ScanDeps = {}
): Promise<Omit<SetupScan, 'saved'>> {
  const git = deps.git ?? readOnlyGit;
  const facts = await repoFacts(repo.root, git);
  const reader = await openRepoReader(repo.root, facts.defaultBranch, git);
  const [stack, checks, files] = await Promise.all([
    detectStack(reader),
    ciChecks(reader),
    repoFiles(reader)
  ]);

  const slug = githubSlug(facts.remote);
  const gh = deps.gh;
  const signedIn = gh !== undefined && (await ghState(gh, repo.root)) === 'ok';
  let required: string[] = [];
  let requiredChecksFrom: RequiredChecksSource = 'no-github';
  if (slug !== null && facts.defaultBranch !== null) {
    if (gh === undefined || !signedIn) requiredChecksFrom = 'gh-signed-out';
    else {
      required = await requiredChecks(gh, repo.root, slug, facts.defaultBranch);
      requiredChecksFrom = required.length > 0 ? 'branch-protection' : 'none-found';
    }
  }

  const member: ProjectMemberSetup = {
    name: repo.name || basename(repo.root),
    path: '.',
    remote: facts.remote,
    defaultBranch: facts.defaultBranch,
    stack: stack.stack,
    packageManager: stack.packageManager,
    setupCommand: stack.setupCommand,
    setupTimeoutSec: DEFAULT_SETUP_TIMEOUT_SEC,
    checkCommands: stack.checkCommands,
    checks,
    requiredChecks: required,
    reviewBots: []
  };
  const setup: ProjectSetup = {
    version: 1,
    kind: 'repo',
    name: member.name,
    members: [member],
    imports: []
  };
  const teamText = files.some((f) => f.kind === 'setup')
    ? await reader.read('.fleet/fleet.agency.toml')
    : null;
  return {
    repo,
    setup,
    repoFiles: files,
    teamSetup: teamText === null ? null : parseSetupToml(teamText),
    readFrom: reader.readFrom,
    requiredChecksFrom,
    ghSignedIn: signedIn
  };
}

/** Read one file at the default branch tip, the way setup read it: for imports. */
export async function readRepoFile(
  root: string,
  path: string,
  git: GitRun = readOnlyGit
): Promise<string | null> {
  const facts = await repoFacts(root, git);
  const reader = await openRepoReader(root, facts.defaultBranch, git);
  return reader.read(path);
}
