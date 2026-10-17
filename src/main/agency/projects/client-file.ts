import { readFileSync } from 'node:fs';
import { mergeClientFile } from '../../../shared/agency-client-file';
import { localDateStamp } from '../../../shared/local-date';
import type { ClientLineInput, RuleCandidates } from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import { writeAtomic } from '../../fs-atomic';
import { readTextOrNull } from './files';
import { agencyHome, clientFilePath } from './paths';
import { openRepoReader, readOnlyGit, repoFacts } from './repo-reader';

/** The most of the client file a turn's note carries, so a runaway file cannot fill the context. */
const NOTE_LIMIT_CHARS = 8_000;

export async function readClientFile(
  repoId: string,
  home: string = agencyHome()
): Promise<string | null> {
  return readTextOrNull(clientFilePath(repoId, home));
}

/**
 * The client file for a turn's note, read fresh each time so a line written
 * mid-job is in the next round. Synchronous: it is a small local file read
 * once per round.
 */
export function clientFileForNote(repoId: string, home: string = agencyHome()): string | null {
  let text: string;
  try {
    text = readFileSync(clientFilePath(repoId, home), 'utf8').trim();
  } catch {
    return null;
  }
  if (text === '') return null;
  return text.length > NOTE_LIMIT_CHARS ? `${text.slice(0, NOTE_LIMIT_CHARS)}\n[cut off]` : text;
}

/**
 * Write lines into a project's client file, each tagged with its source and
 * today's date. See `mergeClientFile` for replacing and duplicates.
 */
export async function writeClientLines(
  input: { repoId: string; name: string; replaceSource?: string; lines: ClientLineInput[] },
  opts: { home?: string; now?: Date } = {}
): Promise<string> {
  const path = clientFilePath(input.repoId, opts.home ?? agencyHome());
  const existing = await readClientFile(input.repoId, opts.home);
  const text = mergeClientFile(
    existing,
    { name: input.name, replaceSource: input.replaceSource, add: input.lines },
    localDateStamp(opts.now)
  );
  await writeAtomic(path, text);
  return text;
}

/** Instruction files whose rules setup offers as client file lines. */
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];
const MAX_RULES = 40;

/**
 * The rules in an agent instruction file: its top-level list items, outside
 * code blocks, that read as a sentence rather than a word or a wall of text.
 */
export function extractRules(markdown: string): string[] {
  const rules: string[] = [];
  let fenced = false;
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const m = /^[-*]\s+(.+)$/.exec(line);
    if (!m) continue;
    const text = m[1].trim();
    if (text.length < 12 || text.length > 240 || rules.includes(text)) continue;
    rules.push(text);
    if (rules.length >= MAX_RULES) break;
  }
  return rules;
}

/**
 * The rules in the repository's `CLAUDE.md` and `AGENTS.md`, read at the
 * default branch tip like the rest of setup. They become client file lines
 * only for the ones the client picks.
 */
export async function ruleCandidates(
  root: string,
  git: GitRun = readOnlyGit
): Promise<RuleCandidates[]> {
  const facts = await repoFacts(root, git);
  const reader = await openRepoReader(root, facts.defaultBranch, git);
  const out: RuleCandidates[] = [];
  for (const source of INSTRUCTION_FILES) {
    const text = await reader.read(source);
    if (text === null) continue;
    const rules = extractRules(text);
    if (rules.length > 0) out.push({ source, rules });
  }
  return out;
}
