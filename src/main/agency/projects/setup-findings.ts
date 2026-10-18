import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { AgencyRepoRef } from '../../../shared/agency';
import { agentFile, skillFolder } from '../../../shared/agency-agent-files';
import {
  githubSlug,
  type EnvFileFound,
  type MemberScan,
  type ProjectKind,
  type ProjectMemberSetup,
  type ProjectSetup,
  type RepoFile,
  type RequiredChecksSource,
  type SetupScan
} from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { ghJson, ghState, type GhRun } from './gh';
import { findEnvFiles } from './env-files';
import { findPorts } from './port-findings';
import { parseSetupToml } from './project-store';
import { openRepoReader, readOnlyGit, repoFacts, type RepoReader } from './repo-reader';

/**
 * Project setup's scan: what a repository is built with, how a fresh worktree
 * gets ready, which checks it has, and which crew files it carries.
 *
 * Read-only and deterministic. It reads the default branch tip out of git's
 * object store, so nothing is checked out and the working tree is not
 * touched; only the untracked env files are read from it, for their variable
 * names. It runs `git` for reading and `gh` for GitHub's view, and never a
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

const ReviewAuthors = z.object({
  data: z.object({
    repository: z.object({
      pullRequests: z.object({
        nodes: z.array(
          z.object({
            reviews: z.object({
              nodes: z.array(
                z.object({
                  author: z.object({ __typename: z.string(), login: z.string() }).nullable()
                })
              )
            })
          })
        )
      })
    })
  })
});

const REVIEW_AUTHORS_QUERY = `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
pullRequests(states:MERGED,first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{reviews(first:50){nodes{author{__typename login}}}}}}}`;

/**
 * The bots that reviewed the last 20 merged PRs, as `login[bot]`, the most
 * reviews first. A person's review does not count, however often.
 */
async function reviewBots(gh: GhRun, root: string, slug: string): Promise<string[]> {
  const [owner, name] = slug.split('/');
  const parsed = ReviewAuthors.safeParse(
    ghJson(
      await gh(
        [
          'api',
          'graphql',
          '-f',
          `owner=${owner}`,
          '-f',
          `name=${name}`,
          '-f',
          `query=${REVIEW_AUTHORS_QUERY}`
        ],
        root
      )
    )
  );
  if (!parsed.success) return [];
  const counts = new Map<string, number>();
  for (const pr of parsed.data.data.repository.pullRequests.nodes) {
    for (const { author } of pr.reviews.nodes) {
      if (author?.__typename !== 'Bot') continue;
      const bot = `${author.login}[bot]`;
      counts.set(bot, (counts.get(bot) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([bot]) => bot);
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
  if (agentFile(path)?.folder === '.') return { path, kind: 'agent', disposition: 'importable' };
  const skill = path.endsWith('/SKILL.md') ? path.slice(0, -'/SKILL.md'.length) : null;
  if (skill !== null && skillFolder(skill)?.folder === '.') {
    return { path: skill, kind: 'skill', disposition: 'in-place' };
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

/** A member to scan: its name, its path from the project root, and its checkout. */
export type ScanMember = { name: string; path: string; root: string };

/** What setup scans: a project's members in member order, and the submodules it could not read. */
export type ScanTarget = {
  repo: AgencyRepoRef;
  kind: ProjectKind;
  members: ScanMember[];
  missing: Array<{ name: string; path: string }>;
};

/** A one-repository project: the repository is its only member. */
export function repoTarget(repo: AgencyRepoRef): ScanTarget {
  return {
    repo,
    kind: 'repo',
    members: [{ name: repo.name || basename(repo.root), path: '.', root: repo.root }],
    missing: []
  };
}

/** A path from the project root, for a path inside a member. */
export function projectPath(memberPath: string, path: string): string {
  return memberPath === '.' ? path : `${memberPath}/${path}`;
}

/** The member a path from the project root is in, and the path inside it: the deepest member that holds it. */
export function memberOfPath<M extends { path: string }>(
  members: M[],
  path: string
): { member: M; path: string } | null {
  const holder = members
    .filter((m) => m.path === '.' || path.startsWith(`${m.path}/`))
    .sort((a, b) => b.path.length - a.path.length)
    .at(0);
  if (holder === undefined) return null;
  return { member: holder, path: holder.path === '.' ? path : path.slice(holder.path.length + 1) };
}

type MemberFindings = {
  member: ProjectMemberSetup;
  scan: MemberScan;
  repoFiles: RepoFile[];
  envFiles: EnvFileFound[];
  reader: RepoReader;
};

async function scanMember(
  target: ScanMember,
  deps: { git: GitRun; gh: GhRun | undefined; signedIn: boolean }
): Promise<MemberFindings> {
  const facts = await repoFacts(target.root, deps.git);
  const reader = await openRepoReader(target.root, facts.defaultBranch, deps.git);
  const [stack, checks, files, ports, envFiles] = await Promise.all([
    detectStack(reader),
    ciChecks(reader),
    repoFiles(reader),
    findPorts(reader),
    findEnvFiles(target.root, target.name, deps.git)
  ]);

  const slug = githubSlug(facts.remote);
  let required: string[] = [];
  let bots: string[] = [];
  let requiredChecksFrom: RequiredChecksSource = 'no-github';
  if (slug !== null && facts.defaultBranch !== null) {
    if (deps.gh === undefined || !deps.signedIn) requiredChecksFrom = 'gh-signed-out';
    else {
      [required, bots] = await Promise.all([
        requiredChecks(deps.gh, target.root, slug, facts.defaultBranch),
        reviewBots(deps.gh, target.root, slug)
      ]);
      requiredChecksFrom = required.length > 0 ? 'branch-protection' : 'none-found';
    }
  }

  return {
    member: {
      name: target.name,
      path: target.path,
      remote: facts.remote,
      defaultBranch: facts.defaultBranch,
      stack: stack.stack,
      packageManager: stack.packageManager,
      setupCommand: stack.setupCommand,
      setupTimeoutSec: DEFAULT_SETUP_TIMEOUT_SEC,
      checkCommands: stack.checkCommands,
      checks,
      requiredChecks: required,
      reviewBots: bots,
      portVars: ports.portVars,
      fixedPorts: ports.fixedPorts,
      envFiles: []
    },
    scan: { name: target.name, path: target.path, readFrom: reader.readFrom, requiredChecksFrom },
    repoFiles: files.map((f) => ({ ...f, path: projectPath(target.path, f.path) })),
    envFiles,
    reader
  };
}

/** Scan a project's members for setup. See the module comment for what it may and may not do. */
export async function scanProject(
  target: ScanTarget,
  deps: ScanDeps = {}
): Promise<Omit<SetupScan, 'saved' | 'newer'>> {
  const git = deps.git ?? readOnlyGit;
  const gh = deps.gh;
  const first = target.members.at(0);
  const signedIn =
    gh !== undefined && first !== undefined && (await ghState(gh, first.root)) === 'ok';
  const found = await Promise.all(
    target.members.map(async (m) => scanMember(m, { git, gh, signedIn }))
  );
  const setup: ProjectSetup = {
    version: 1,
    kind: target.kind,
    name: target.repo.name,
    members: found.map((f) => f.member),
    imports: [],
    setupCommand: '',
    setupTimeoutSec: DEFAULT_SETUP_TIMEOUT_SEC,
    // A port no variable moves lets only one stack hold it at a time.
    stackSlots: found.some((f) => f.member.fixedPorts.length > 0) ? 1 : null
  };
  // A teammate's setup lives in the project root's repository: the umbrella, or the one repository.
  const root = found.find((f) => f.member.path === '.');
  const teamText = root?.repoFiles.some((f) => f.kind === 'setup')
    ? await root.reader.read('.fleet/fleet.agency.toml')
    : null;
  return {
    repo: target.repo,
    kind: target.kind,
    setup,
    members: found.map((f) => f.scan),
    missing: target.missing,
    repoFiles: found.flatMap((f) => f.repoFiles),
    envFiles: found.flatMap((f) => f.envFiles),
    teamSetup: teamText === null ? null : parseSetupToml(teamText),
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
