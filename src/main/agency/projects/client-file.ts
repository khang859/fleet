import { readFileSync } from 'node:fs';
import type { ClientFileProposal } from '../../../shared/agency';
import { applyClientProposal, mergeClientFile } from '../../../shared/agency-client-file';
import { localDateStamp } from '../../../shared/local-date';
import type { ClientLineInput, RuleCandidates } from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import type { AgencyStore } from '../store/agency-store';
import { writeAtomicSync } from '../../fs-atomic';
import { clientFilePath } from './paths';
import { openRepoReader, readOnlyGit, repoFacts } from './repo-reader';

/** The most of the client file a turn's note carries, so a runaway file cannot fill the context. */
const NOTE_LIMIT_CHARS = 8_000;

/** Past this size the Admiral is asked to propose a cleanup. */
export const CLIENT_FILE_CLEANUP_CHARS = 6_000;

/** The client file as a turn's note carries it. */
export type ClientFileNote = {
  text: string;
  /** The file changed outside Fleet; `text` is what Fleet last wrote until the client keeps the change. */
  changedOutside: boolean;
  /** Past `CLIENT_FILE_CLEANUP_CHARS`: time to propose a cleanup. */
  oversize: boolean;
};

/**
 * The client files: one Markdown file per repository, changed only by the
 * Fleet UI (starter answers, the Settings editor) or a proposal the client
 * approved. Each write is noted in the store, so a change made any other way
 * (by hand in an editor, or by a crew member) shows as changed outside Fleet,
 * and the Admiral keeps working from Fleet's last version until the client
 * keeps the change.
 *
 * Reads and writes are synchronous: the files are small and local, and an
 * approved line has to be on disk before the wakeup that reports it runs.
 */
export class ClientFiles {
  constructor(
    private readonly deps: {
      store: Pick<AgencyStore, 'clientFileMark' | 'markClientFile'>;
      home: () => string;
      now?: () => Date;
    }
  ) {}

  path(repoId: string): string {
    return clientFilePath(repoId, this.deps.home());
  }

  /** The file as it is on disk; empty when there is none. */
  read(repoId: string): string {
    try {
      return readFileSync(this.path(repoId), 'utf8');
    } catch {
      return '';
    }
  }

  changedOutside(repoId: string): boolean {
    return this.read(repoId) !== (this.deps.store.clientFileMark(repoId) ?? '');
  }

  /** Write the whole file, as the client's Save in Settings does: hand edits win. */
  write(repoId: string, text: string): void {
    writeAtomicSync(this.path(repoId), text);
    this.deps.store.markClientFile(repoId, text);
  }

  /** The client keeps the file as it is now, outside change and all. */
  keep(repoId: string): void {
    this.deps.store.markClientFile(repoId, this.read(repoId));
  }

  /** Add tagged lines. See `mergeClientFile` for replacing a source and duplicates. */
  merge(
    repoId: string,
    input: { name: string; replaceSource?: string; lines: ClientLineInput[] }
  ): string {
    const text = mergeClientFile(
      this.read(repoId) || null,
      { name: input.name, replaceSource: input.replaceSource, add: input.lines },
      this.today()
    );
    this.write(repoId, text);
    return text;
  }

  /** Write an approved proposal in, tagged with where it came from. */
  apply(
    repoId: string,
    input: { name: string; source: string; proposal: ClientFileProposal }
  ): string {
    const text = applyClientProposal(this.read(repoId) || null, input, this.today());
    this.write(repoId, text);
    return text;
  }

  /**
   * The client file for a turn's note, read fresh each round so a line written
   * mid-job is in the next one. While an outside change waits on the client,
   * it is Fleet's last version, never the changed one.
   */
  forNote(repoId: string): ClientFileNote | null {
    const changedOutside = this.changedOutside(repoId);
    const base = (
      changedOutside ? (this.deps.store.clientFileMark(repoId) ?? '') : this.read(repoId)
    ).trim();
    if (base === '' && !changedOutside) return null;
    return {
      text: base.length > NOTE_LIMIT_CHARS ? `${base.slice(0, NOTE_LIMIT_CHARS)}\n[cut off]` : base,
      changedOutside,
      oversize: base.length > CLIENT_FILE_CLEANUP_CHARS
    };
  }

  private today(): string {
    return localDateStamp(this.deps.now?.());
  }
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
