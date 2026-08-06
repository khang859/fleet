import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AgentHistoryEntry, HISTORY_LIMIT, recallable } from '../../shared/agent-history';
import { createLogger } from '../logger';

const log = createLogger('agent:history');

const HISTORY_FILE = join(homedir(), '.fleet', 'agent', 'history.jsonl');

/**
 * Compact once the file has this many lines.
 *
 * Slack above the budget rather than a rewrite per prompt: appending is what
 * keeps a submit cheap, and the whole file is read anyway the first time a pane
 * asks. Every harness I looked at simply never compacts - Claude Code's is 19k
 * lines and 4.4MB on this machine, and Codex has an open issue asking for
 * rotation - which is fine right up until that read.
 */
const COMPACT_AT = 2000;

/**
 * The prompts typed into agent panes, one JSONL line each.
 *
 * Append-only with occasional compaction, alongside the sessions in
 * `~/.fleet/agent`. Each line carries the folder it was typed against, so one
 * file serves every pane and recall is a filter rather than a lookup. That is
 * also what lets a pane opened on a folder today offer what was typed there
 * last week, in a pane that no longer exists.
 *
 * Nothing here is authoritative about a conversation - this file existing or
 * not changes what Up offers and nothing else. So a line that will not parse is
 * skipped rather than raised, and a write that fails is logged and dropped.
 */
export class AgentHistoryStore {
  /** Read once on first use, then kept: every write goes through here too. */
  private entries: AgentHistoryEntry[] | null = null;

  constructor(private readonly file: string = HISTORY_FILE) {}

  /** What Up walks through in this folder: newest first, each prompt once. */
  list(cwd: string): string[] {
    return recallable(this.load(), cwd);
  }

  /**
   * Remember a prompt. The same text twice in a row in the same folder is one
   * entry - resending something is an ordinary thing to do, and a list where
   * two presses of Up land on the same words is a list with a hole in it.
   */
  add(cwd: string, text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    const entries = this.load();
    const last = entries.at(-1);
    if (last?.text === trimmed && last.cwd === cwd) return;

    const entry: AgentHistoryEntry = { text: trimmed, cwd, at: Date.now() };
    entries.push(entry);

    if (entries.length >= COMPACT_AT) {
      this.compact();
      return;
    }
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (err) {
      log.warn('could not append to history', err);
    }
  }

  private load(): AgentHistoryEntry[] {
    this.entries ??= this.read();
    return this.entries;
  }

  /**
   * Rewrite the file, keeping the newest `HISTORY_LIMIT` of each folder.
   *
   * Through a temporary file and a rename, because this is the one moment the
   * store is not append-only and so the one moment it could lose everything: a
   * crash midway leaves the previous file whole rather than a half-written one.
   */
  private compact(): void {
    const perFolder = new Map<string, AgentHistoryEntry[]>();
    for (const entry of this.load()) {
      const bucket = perFolder.get(entry.cwd);
      if (bucket === undefined) perFolder.set(entry.cwd, [entry]);
      else bucket.push(entry);
    }
    const kept: AgentHistoryEntry[] = [];
    for (const bucket of perFolder.values()) kept.push(...bucket.slice(-HISTORY_LIMIT));
    // Back into the order they were typed in, which is the order the file is
    // read in and the order `recallable` walks backwards through.
    kept.sort((a, b) => a.at - b.at);
    this.entries = kept;

    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temp, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''), 'utf8');
      renameSync(temp, this.file);
      log.info(`compacted prompt history to ${kept.length} entries`);
    } catch (err) {
      log.warn('could not compact history', err);
    }
  }

  /** Every line that still parses. A bad one is skipped, not thrown. */
  private read(): AgentHistoryEntry[] {
    if (!existsSync(this.file)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch (err) {
      log.warn('could not read history', err);
      return [];
    }
    const entries: AgentHistoryEntry[] = [];
    for (const line of raw.split('\n')) {
      if (line.trim() === '') continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = AgentHistoryEntry.safeParse(value);
      if (parsed.success) entries.push(parsed.data);
    }
    return entries;
  }
}
