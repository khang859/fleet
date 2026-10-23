import { readFileSync } from 'node:fs';
import type { ClientFileProposal } from '../../../shared/agency';
import {
  applyClientProposal,
  editClientLine,
  mergeClientFile,
  numberedEntries,
  numberedText,
  removeClientLine,
  YOU_LAYER,
  YOU_SOURCE
} from '../../../shared/agency-client-file';
import { localDateStamp } from '../../../shared/local-date';
import type { PlanUse } from '../../../shared/agency-jobs';
import type {
  ClientLineChange,
  ClientLineInput,
  ClientLineResult,
  RuleCandidates
} from '../../../shared/agency-projects';
import type { GitRun } from '../repo-identity';
import type { AgencyStore } from '../store/agency-store';
import type { PreferenceStore } from '../store/preference-store';
import { writeAtomicSync } from '../../fs-atomic';
import { clientFilePath } from './paths';
import { openRepoReader, readOnlyGit, repoFacts } from './repo-reader';

/** The most of one layer a turn's note carries, so a runaway file cannot fill the context. */
const NOTE_LIMIT_CHARS = 4_000;

/** Past this size a layer's cleanup is due, before the note starts cutting it off. */
export const CLIENT_FILE_CLEANUP_CHARS = 3_500;

/** Both layers of the client's preferences for a turn's note; a layer with nothing in it is null. */
export type PreferencesNote = {
  you: ClientFileNote | null;
  project: ClientFileNote | null;
};

/** One layer of the client's preferences as a turn's note carries it. */
export type ClientFileNote = {
  text: string;
  /** The file changed outside Fleet; `text` is what Fleet last wrote until the client keeps the change. */
  changedOutside: boolean;
  /** Past `CLIENT_FILE_CLEANUP_CHARS`: time to propose a cleanup. */
  oversize: boolean;
};

/**
 * The client files: the client's preferences as Markdown, one file per layer
 * (`YOU_LAYER` for every project, and one per project keyed by its id),
 * changed only by the Fleet UI (answers, the Settings page) or a proposal the
 * client approved. Each write is noted in the store, so a change made any other way
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
      store: Pick<AgencyStore, 'clientFileMark' | 'markClientFile'> & {
        preferences: Pick<PreferenceStore, 'conflicts'>;
      };
      home: () => string;
      now?: () => Date;
    }
  ) {}

  path(layer: string): string {
    return clientFilePath(layer, this.deps.home());
  }

  /** The file as it is on disk; empty when there is none. */
  read(layer: string): string {
    try {
      return readFileSync(this.path(layer), 'utf8');
    } catch {
      return '';
    }
  }

  changedOutside(layer: string): boolean {
    return this.read(layer) !== this.lastWritten(layer);
  }

  /** Write the whole file, as the client's Save in Settings does: hand edits win. */
  write(layer: string, text: string): void {
    writeAtomicSync(this.path(layer), text);
    this.deps.store.markClientFile(layer, text);
  }

  /** The client keeps the file as it is now, outside change and all. */
  keep(layer: string): void {
    this.deps.store.markClientFile(layer, this.read(layer));
  }

  /** The client undoes a change made outside Fleet: the file goes back to Fleet's last version. */
  undo(layer: string): void {
    this.write(layer, this.lastWritten(layer));
  }

  /**
   * A change the client made on the What the Admiral knows page: add a line,
   * or edit or remove the line at `index` that said `was`. Refused while the
   * layer has an outside change the client has not kept, or when the line is
   * no longer there as the client saw it.
   */
  changeLine(layer: string, change: ClientLineChange): ClientLineResult {
    if (this.changedOutside(layer)) {
      return {
        ok: false,
        reason: 'This file changed outside Fleet. Keep or undo that change first.'
      };
    }
    const existing = this.read(layer) || null;
    const text =
      change.kind === 'add'
        ? mergeClientFile(
            existing,
            { name: change.name, add: [{ text: change.text, source: YOU_SOURCE }] },
            this.today()
          )
        : change.kind === 'edit'
          ? editClientLine(existing, change, this.today())
          : removeClientLine(existing, change);
    if (text === null) return { ok: false, reason: 'That line changed since you opened it.' };
    this.write(layer, text);
    return { ok: true };
  }

  /** Add tagged lines. See `mergeClientFile` for replacing a source and duplicates. */
  merge(
    layer: string,
    input: { name: string; replaceSource?: string; lines: ClientLineInput[] }
  ): string {
    const text = mergeClientFile(
      this.read(layer) || null,
      { name: input.name, replaceSource: input.replaceSource, add: input.lines },
      this.today()
    );
    this.write(layer, text);
    return text;
  }

  /** Write an approved proposal in, tagged with where it came from. */
  apply(
    layer: string,
    input: { name: string; source: string; proposal: Pick<ClientFileProposal, 'add' | 'remove'> }
  ): string {
    const text = applyClientProposal(this.read(layer) || null, input, this.today());
    this.write(layer, text);
    return text;
  }

  /**
   * A layer for a turn's note, read fresh each round so a line written
   * mid-job is in the next one. While an outside change waits on the client,
   * it is Fleet's last version, never the changed one.
   */
  forNote(layer: string): ClientFileNote | null {
    const changedOutside = this.changedOutside(layer);
    const overrides = new Map(
      this.deps.store.preferences
        .conflicts(layer)
        .filter((c) => c.status === 'line')
        .map((c) => [c.normText, c.ruleSource])
    );
    const base = numberedText(this.noteText(layer), layer === YOU_LAYER ? 'Y' : 'P', overrides);
    if (base === '' && !changedOutside) return null;
    return {
      text: base.length > NOTE_LIMIT_CHARS ? `${base.slice(0, NOTE_LIMIT_CHARS)}\n[cut off]` : base,
      changedOutside,
      oversize: base.length > CLIENT_FILE_CLEANUP_CHARS
    };
  }

  /** The layer's lines by the ids the note gives them now, for a plan's `uses`. */
  noteLines(layer: string): PlanUse[] {
    const you = layer === YOU_LAYER;
    return numberedEntries(this.noteText(layer), you ? 'Y' : 'P').map(({ id, entry }) => ({
      id,
      layer: you ? 'you' : 'project',
      text: entry.text
    }));
  }

  /** The layer as the note reads it: Fleet's last version while an outside change waits. */
  private noteText(layer: string): string {
    return this.changedOutside(layer) ? this.lastWritten(layer) : this.read(layer);
  }

  /** The layer as Fleet last wrote it, or the client last kept it; empty when neither has. */
  private lastWritten(layer: string): string {
    return this.deps.store.clientFileMark(layer) ?? '';
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
