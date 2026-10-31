import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse, TomlError } from 'smol-toml';
import { z } from 'zod';
import type { WorkflowDef, WorkflowScope } from '../../shared/workflows';

/** Where a project keeps its workflows, from its root. */
export const PROJECT_WORKFLOWS_DIR = join('.fleet', 'workflows');

/** A file over this size is not a workflow. */
const MAX_FILE_BYTES = 256 * 1024;

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_-]+)\s*\}\}/g;

const Name = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_-]*$/, 'must use a-z, 0-9, _ and -, and start with a letter');

const Input = z.strictObject({
  name: Name,
  label: z.string().min(1).max(80),
  type: z.enum(['text', 'pr']).default('text'),
  required: z.boolean().default(true)
});

// Only these two names, on purpose: a shared file must never run a command.
const Agent = z.strictObject({
  role: z.string().min(1).max(60),
  program: z.enum(['pi', 'claude']),
  prompt: z.string().min(1).max(20_000)
});

const Finish = z.strictObject({
  action: z.enum(['save-report', 'post-pr']),
  path: z.string().max(400).optional()
});

const WorkflowFile = z.strictObject({
  name: z.string().min(1).max(80),
  shared: z.string().max(20_000).default(''),
  board: z.boolean().default(true),
  workspace: z.enum(['current', 'pr-worktree']).default('current'),
  inputs: z.array(Input).max(10).default([]),
  agents: z.array(Agent).min(1).max(12),
  judge: Agent.optional(),
  finish: Finish.optional()
});

export class WorkflowFileError extends Error {}

/** What the parser and the schema say, as one line per problem. */
function describe(error: z.ZodError, text: string): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.');
      // An unknown key is named in `keys`: its path stops at the table around it.
      const named = issue.code === 'unrecognized_keys' ? [issue.keys[0]] : issue.path;
      const line = lineOfKey(text, named);
      const at = line === null ? '' : `Line ${line}: `;
      return `${at}${path ? `${path}: ` : ''}${issue.message}`;
    })
    .join('\n');
}

/** The first line that starts with the deepest named key, as a good enough pointer. */
function lineOfKey(text: string, path: PropertyKey[]): number | null {
  const key = [...path].reverse().find((part) => typeof part === 'string');
  if (typeof key !== 'string') return null;
  const at = text.split('\n').findIndex((line) => keyOfLine(line) === key);
  return at < 0 ? null : at + 1;
}

/** The key or table name a TOML line starts with. */
function keyOfLine(line: string): string {
  const [first] = line
    .trim()
    .replace(/^\[+/, '')
    .split(/[\s=\]]/);
  return first.replace(/^["']|["']$/g, '');
}

/** Every placeholder a text names. */
function placeholders(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

/** The rules TOML shape cannot state. Each one has its message in the design doc. */
function checkRules(def: WorkflowDef): string[] {
  const problems: string[] = [];
  const names = new Set(def.inputs.map((input) => input.name));
  if (names.size !== def.inputs.length) problems.push('Two inputs have the same name.');

  const known = new Set([...names, 'slug']);
  const prompts = [...def.agents, ...(def.judge ? [def.judge] : [])].map((agent) => agent.prompt);
  const texts = [def.shared, ...prompts, def.finish?.path ?? ''];
  for (const name of new Set(texts.flatMap(placeholders))) {
    if (!known.has(name)) problems.push(`The placeholder {{${name}}} has no matching input.`);
  }

  const prInputs = def.inputs.filter((input) => input.type === 'pr');
  if (def.workspace === 'pr-worktree' && (prInputs.length !== 1 || !prInputs[0].required)) {
    problems.push('workspace = "pr-worktree" needs exactly one required input with type = "pr".');
  }
  if (def.finish?.action === 'post-pr' && def.workspace !== 'pr-worktree') {
    problems.push('action = "post-pr" needs workspace = "pr-worktree".');
  }
  if (def.finish?.path !== undefined && !def.finish.path.endsWith('.md')) {
    problems.push('finish.path must end in .md.');
  }
  const roles = [...def.agents, ...(def.judge ? [def.judge] : [])].map((agent) => agent.role);
  if (new Set(roles).size !== roles.length) problems.push('Two agents have the same role.');
  return problems;
}

/** The workflow a file describes. Throws `WorkflowFileError` with what is wrong in it. */
export function parseWorkflow(text: string): WorkflowDef {
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    if (err instanceof TomlError) throw new WorkflowFileError(`Line ${err.line}: ${err.message}`);
    throw err;
  }
  const parsed = WorkflowFile.safeParse(data);
  if (!parsed.success) throw new WorkflowFileError(describe(parsed.error, text));
  const problems = checkRules(parsed.data);
  if (problems.length > 0) throw new WorkflowFileError(problems.join('\n'));
  return parsed.data;
}

export function hashText(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type WorkflowBytes = { text: string; hash: string };

/**
 * The one way to read a workflow file. A symlink is refused, so a repo cannot
 * point Fleet at a file outside it. The hash covers the bytes as read.
 */
export function readWorkflowFile(path: string): WorkflowBytes {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new WorkflowFileError(`${basename(path)} is a symlink.`);
  if (!stat.isFile()) throw new WorkflowFileError(`${basename(path)} is not a file.`);
  if (stat.size > MAX_FILE_BYTES) throw new WorkflowFileError(`${basename(path)} is too large.`);
  const bytes = readFileSync(path);
  return { text: bytes.toString('utf8'), hash: hashText(bytes) };
}

export type FoundFile = { id: string; path: string; scope: WorkflowScope };

function tomlFilesIn(dir: string, scope: WorkflowScope): FoundFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.toml'))
    .sort()
    .map((name) => ({ id: name.slice(0, -'.toml'.length), path: join(dir, name), scope }));
}

/** Project files first, then the personal files whose names no project file took. */
export function findWorkflowFiles(
  projectPath: string,
  personalDir: string
): { files: FoundFile[]; replaced: Set<string> } {
  const project = tomlFilesIn(join(projectPath, PROJECT_WORKFLOWS_DIR), 'project');
  const taken = new Set(project.map((file) => file.id));
  const personal = tomlFilesIn(personalDir, 'personal');
  const replaced = new Set(personal.filter((file) => taken.has(file.id)).map((file) => file.id));
  return { files: [...project, ...personal.filter((file) => !taken.has(file.id))], replaced };
}

/** Fill `{{name}}` from `values`. Every name was checked when the file was parsed. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => values[name] ?? whole);
}

/** A safe file name part from a title, up to 60 characters of `a-z`, `0-9` and `-`. */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug === '' ? 'run' : slug;
}

/** `{{slug}}`: the PR number when the workflow has one, or else the first text input. */
export function slugOf(def: WorkflowDef, inputs: Record<string, string>): string {
  const pr = def.inputs.find((input) => input.type === 'pr');
  if (pr) return slugify(`pr-${inputs[pr.name] ?? ''}`);
  const text = def.inputs.find((input) => input.type === 'text');
  return slugify(text ? (inputs[text.name] ?? '') : def.name);
}

/** What makes a start the same as another: the PR number, or else the input values. */
export function targetOf(def: WorkflowDef, inputs: Record<string, string>): string {
  const pr = def.inputs.find((input) => input.type === 'pr');
  if (pr) return `pr:${inputs[pr.name] ?? ''}`;
  return JSON.stringify(def.inputs.map((input) => inputs[input.name] ?? ''));
}
