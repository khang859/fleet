import type { ClaudeSessionUsage, GitSummary } from '../../shared/claude-sessions';
import { isRecord } from '../../shared/is-record';
import { toolInputPreview, type PromptSource, type TranscriptEvent } from './transcript';

/**
 * A short, deterministic summary of what a Claude Code session is doing,
 * built from its transcript events without a model in the loop.
 *
 * Every item records the revision it last changed at. The revision goes up by
 * one for each event that changes the brief, so a reader that remembers the
 * revision it last saw can ask for only what changed since.
 */

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type BriefTodo = { id: string; subject: string; status: TodoStatus };

export type BriefCommand = {
  toolUseId: string;
  command: string;
  /** Null while the command still runs. */
  ok: boolean | null;
  rev: number;
};

export type BriefFailure = {
  tool: string;
  preview: string;
  /** The start of the error the tool returned, or why it did not run. */
  error: string;
  rev: number;
};

export type BriefQuestion = {
  toolUseId: string;
  questions: Array<{ question: string; options: string[] }>;
};

type Item<T> = { value: T; rev: number };

export type SessionBriefState = {
  rev: number;
  turns: number;
  /** The first thing the user asked for since the session began or was cleared. */
  goal: Item<string> | null;
  /** The prompt the current or last turn answers. */
  prompt: Item<string> | null;
  todos: Item<BriefTodo[]> | null;
  plan: Item<{ text: string; approved: boolean | null }> | null;
  /** Files the session changed, most recent last. */
  files: Map<string, number>;
  commands: BriefCommand[];
  failures: BriefFailure[];
  /** The last thing Claude said, and in which turn. */
  reply: Item<{ text: string; turn: number }> | null;
  question: Item<BriefQuestion> | null;
};

const FILE_LIMIT = 30;
const COMMAND_LIMIT = 8;
const FAILURE_LIMIT = 5;
/** How much of a long text is kept; more than rendering ever shows. */
const KEEP_CHARS = 4_000;
/** How many tool calls to remember while their results are awaited. */
const PENDING_LIMIT = 200;

const FILE_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit']);

function emptyState(rev: number): SessionBriefState {
  return {
    rev,
    turns: 0,
    goal: null,
    prompt: null,
    todos: null,
    plan: null,
    files: new Map(),
    commands: [],
    failures: [],
    reply: null,
    question: null
  };
}

function keep(text: string): string {
  return text.length > KEEP_CHARS ? text.slice(0, KEEP_CHARS) : text;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'completed';
}

function todoStatus(value: unknown): TodoStatus {
  return isTodoStatus(value) ? value : 'pending';
}

/** The questions an AskUserQuestion call puts to the user. */
function questionsOf(input: Record<string, unknown>): BriefQuestion['questions'] {
  const raw = input['questions'];
  if (!Array.isArray(raw)) return [];
  const out: BriefQuestion['questions'] = [];
  for (const q of raw) {
    if (!isRecord(q)) continue;
    const options = Array.isArray(q['options'])
      ? q['options'].flatMap((o) => (isRecord(o) ? (str(o['label']) ?? []) : []))
      : [];
    out.push({ question: str(q['question']) ?? '', options });
  }
  return out;
}

/** A pending tool call, kept until its result says whether it worked. */
type Pending = { name: string; input: Record<string, unknown> };

/**
 * Folds transcript events into a {@link SessionBriefState}. Feed it every
 * event of a transcript in order, all at once or as they arrive: the result is
 * the same.
 */
export class BriefBuilder {
  private s: SessionBriefState = emptyState(0);
  private readonly pending = new Map<string, Pending>();
  /** Task ids handed out so far, for a create whose result names none. */
  private created = 0;

  get state(): SessionBriefState {
    return this.s;
  }

  apply(event: TranscriptEvent): void {
    switch (event.kind) {
      case 'clear':
        // A cleared conversation starts a new brief; revisions keep counting
        // so a reader's cursor never points into the future.
        this.s = emptyState(this.s.rev + 1);
        this.pending.clear();
        this.created = 0;
        return;
      case 'user_prompt':
        this.prompt(event.text, event.source);
        return;
      case 'assistant_text':
        if (event.text.trim()) {
          this.s.reply = {
            value: { text: keep(event.text), turn: this.s.turns },
            rev: this.bump()
          };
        }
        return;
      case 'tool_use':
        this.toolUse(event.id, event.name, event.input);
        return;
      case 'tool_result':
        this.toolResult(event.toolUseId, event.isError, event.rejected, event.text);
        return;
      case 'interrupted':
        if (this.s.question) {
          this.s.question = null;
          this.bump();
        }
        return;
      case 'thinking':
      case 'queue':
      case 'meta':
        return;
    }
  }

  private bump(): number {
    return ++this.s.rev;
  }

  private prompt(text: string, source: PromptSource): void {
    if (source === 'compact') return;
    const rev = this.bump();
    this.s.turns++;
    this.s.prompt = { value: keep(text), rev };
    if (!this.s.goal && source !== 'task') this.s.goal = { value: keep(text), rev };
    // A new prompt answers any open question.
    this.s.question = null;
  }

  private toolUse(id: string, name: string, input: Record<string, unknown>): void {
    if (id) {
      this.pending.set(id, { name, input });
      if (this.pending.size > PENDING_LIMIT) {
        const oldest = this.pending.keys().next().value;
        if (oldest !== undefined) this.pending.delete(oldest);
      }
    }
    if (name === 'AskUserQuestion') {
      this.s.question = {
        value: { toolUseId: id, questions: questionsOf(input) },
        rev: this.bump()
      };
    } else if (name === 'ExitPlanMode') {
      const plan = str(input['plan']);
      if (plan) this.s.plan = { value: { text: keep(plan), approved: null }, rev: this.bump() };
    } else if (name === 'Bash') {
      const command = str(input['command']);
      if (command) {
        this.s.commands.push({ toolUseId: id, command: keep(command), ok: null, rev: this.bump() });
        if (this.s.commands.length > COMMAND_LIMIT) this.s.commands.shift();
      }
    }
  }

  private toolResult(toolUseId: string, isError: boolean, rejected: boolean, text: string): void {
    const call = this.pending.get(toolUseId);
    if (!call) return;
    this.pending.delete(toolUseId);
    const { name, input } = call;
    const ok = !isError && !rejected;

    if (this.s.question?.value.toolUseId === toolUseId) {
      this.s.question = null;
      this.bump();
    }
    if (name === 'ExitPlanMode' && this.s.plan) {
      this.s.plan = { value: { ...this.s.plan.value, approved: ok }, rev: this.bump() };
    }
    if (name === 'Bash') {
      const entry = this.s.commands.find((c) => c.toolUseId === toolUseId);
      if (entry) {
        entry.ok = ok;
        entry.rev = this.bump();
      }
    }
    if (!ok) {
      this.s.failures.push({
        tool: name,
        preview: toolInputPreview(name, input),
        error: rejected ? 'rejected by the user' : text.trim().slice(0, 300),
        rev: this.bump()
      });
      if (this.s.failures.length > FAILURE_LIMIT) this.s.failures.shift();
      return;
    }
    if (FILE_TOOLS.has(name)) {
      const path = str(input['file_path']) ?? str(input['notebook_path']);
      if (path) {
        this.s.files.delete(path);
        this.s.files.set(path, this.bump());
        if (this.s.files.size > FILE_LIMIT) {
          const oldest = this.s.files.keys().next().value;
          if (oldest !== undefined) this.s.files.delete(oldest);
        }
      }
    }
    if (name === 'TodoWrite') this.todoWrite(input);
    if (name === 'TaskCreate') this.taskCreate(input, text);
    if (name === 'TaskUpdate') this.taskUpdate(input);
  }

  private todoWrite(input: Record<string, unknown>): void {
    const raw = input['todos'];
    if (!Array.isArray(raw)) return;
    const todos: BriefTodo[] = [];
    raw.forEach((t, i) => {
      if (!isRecord(t)) return;
      todos.push({
        id: String(i + 1),
        subject: str(t['content']) ?? '',
        status: todoStatus(t['status'])
      });
    });
    this.s.todos = { value: todos, rev: this.bump() };
  }

  /** Claude Code 2.1.285 answers `Task #1 created successfully: <subject>`. */
  private taskCreate(input: Record<string, unknown>, result: string): void {
    const id = /^Task #(\S+) created/.exec(result)?.[1] ?? String(this.created + 1);
    const n = Number(id);
    if (Number.isInteger(n)) this.created = Math.max(this.created, n);
    const todos = (this.s.todos?.value ?? []).filter((t) => t.id !== id);
    todos.push({ id, subject: str(input['subject']) ?? '', status: 'pending' });
    this.s.todos = { value: todos, rev: this.bump() };
  }

  private taskUpdate(input: Record<string, unknown>): void {
    const id = str(input['taskId']) ?? str(input['id']);
    const current = this.s.todos?.value;
    if (!id || !current?.some((t) => t.id === id)) return;
    const status = str(input['status']);
    const subject = str(input['subject']);
    const todos =
      status === 'deleted'
        ? current.filter((t) => t.id !== id)
        : current.map((t) =>
            t.id === id
              ? {
                  ...t,
                  subject: subject ?? t.subject,
                  status: status ? todoStatus(status) : t.status
                }
              : t
          );
    this.s.todos = { value: todos, rev: this.bump() };
  }
}

/** What the registry knows about a session, shown at the top of its brief. */
export type BriefStatus = {
  /** One line such as `working for 2m` or `waiting for approval of Bash`. */
  phase: string;
  usage: ClaudeSessionUsage | null;
  git: GitSummary | null;
  /** The session's folder; paths inside it are shown relative to it. */
  cwd?: string;
};

export type RenderOptions = {
  /** Only what changed after this revision; the status line is always shown. */
  since?: number;
  /** The most characters to return. */
  cap?: number;
};

export const BRIEF_CAP = 3_500;

type Section = { title: string; lines: string[] };

function clip(text: string, max: number): string {
  const one = text.trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

// eslint-disable-next-line no-control-regex -- terminal colour codes are what it removes
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function oneLine(text: string, max: number): string {
  return clip(text.replace(ANSI, '').replace(/\s+/g, ' '), max);
}

function tag(text: string, name: string): string | null {
  const match = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return match ? match[1].trim() : null;
}

/**
 * A prompt as the user would recognise it: a slash command as they typed it,
 * a finished background task by its summary.
 */
function promptText(text: string): string {
  const command = tag(text, 'command-name');
  if (command) return `${command} ${tag(text, 'command-args') ?? ''}`.trim();
  if (text.startsWith('<task-notification>')) {
    const summary = tag(text, 'summary') ?? tag(text, 'status') ?? 'finished';
    return `[background task] ${summary}`;
  }
  return text;
}

function relativeTo(path: string, cwd: string | undefined): string {
  if (!cwd) return path;
  const base = cwd.endsWith('/') ? cwd : `${cwd}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** A multi-line text's first line, marked as cut when there is more. */
function firstLine(text: string, max: number): string {
  const [first = '', ...rest] = text.trim().split('\n');
  return rest.length > 0 ? `${clip(first, max - 2)} …` : clip(first, max);
}

function statusLine(status: BriefStatus): string {
  const parts = [status.phase];
  const { usage, git } = status;
  if (usage?.costUsd != null) parts.push(`~$${usage.costUsd.toFixed(2)}`);
  if (usage?.contextTokens != null && usage.contextLimit) {
    parts.push(`context ${Math.round((usage.contextTokens / usage.contextLimit) * 100)}%`);
  }
  if (git) {
    const dirty =
      git.dirtyFiles > 0
        ? `, ${git.dirtyFiles} changed (+${git.insertions} -${git.deletions})`
        : ', clean';
    parts.push(`git ${git.branch}${dirty}`);
  }
  return parts.join(' · ');
}

const TODO_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]'
};

function sections(s: SessionBriefState, since: number, cwd: string | undefined): Section[] {
  const fresh = (rev: number): boolean => rev > since;
  const out: Section[] = [];
  if (s.question && fresh(s.question.rev)) {
    out.push({
      title: 'Waiting on a question',
      lines: s.question.value.questions.map(
        (q) =>
          `${oneLine(q.question, 300)}${q.options.length ? ` (options: ${q.options.join(' | ')})` : ''}`
      )
    });
  }
  if (s.goal && fresh(s.goal.rev))
    out.push({ title: 'Goal', lines: [oneLine(promptText(s.goal.value), 400)] });
  if (s.prompt && fresh(s.prompt.rev) && s.prompt.value !== s.goal?.value) {
    out.push({
      title: `Latest prompt (turn ${s.turns})`,
      lines: [oneLine(promptText(s.prompt.value), 400)]
    });
  }
  if (s.reply && fresh(s.reply.rev)) {
    const { text, turn } = s.reply.value;
    const title = turn === s.turns ? 'Last reply' : `Last reply (turn ${turn})`;
    out.push({ title, lines: [clip(text, 700)] });
  }
  if (s.todos && fresh(s.todos.rev) && s.todos.value.length > 0) {
    out.push({
      title: 'Todos',
      lines: s.todos.value.map((t) => `${TODO_MARK[t.status]} ${oneLine(t.subject, 120)}`)
    });
  }
  // Newest first in each list, so a cut drops the oldest.
  const failures = s.failures.filter((f) => fresh(f.rev)).reverse();
  if (failures.length > 0) {
    out.push({
      title: 'Failures',
      lines: failures.map(
        (f) => `${f.tool}${f.preview ? ` ${oneLine(f.preview, 80)}` : ''}: ${oneLine(f.error, 200)}`
      )
    });
  }
  if (s.plan && fresh(s.plan.rev)) {
    const state =
      s.plan.value.approved === null
        ? 'proposed'
        : s.plan.value.approved
          ? 'approved'
          : 'not approved';
    out.push({ title: `Plan (${state})`, lines: [clip(s.plan.value.text, 900)] });
  }
  const files = [...s.files]
    .filter(([, rev]) => fresh(rev))
    .map(([path]) => relativeTo(path, cwd))
    .reverse();
  if (files.length > 0) out.push({ title: 'Files changed', lines: files });
  const commands = s.commands.filter((c) => fresh(c.rev)).reverse();
  if (commands.length > 0) {
    out.push({
      title: 'Commands',
      lines: commands.map(
        (c) => `${c.ok === null ? '…' : c.ok ? 'ok' : 'failed'}  ${firstLine(c.command, 160)}`
      )
    });
  }
  return out;
}

/**
 * The brief as text for a model to read, at most `cap` characters. When it
 * does not fit, whole lines are cut from the end and the brief says which
 * sections lost them.
 */
export function renderBrief(
  state: SessionBriefState,
  status: BriefStatus,
  opts: RenderOptions = {}
): string {
  const since = opts.since ?? 0;
  const cap = opts.cap ?? BRIEF_CAP;
  const head = [statusLine(status), `turns: ${state.turns} · rev ${state.rev}`];
  const body = sections(state, since, status.cwd);
  if (body.length === 0) {
    head.push(since > 0 ? 'Nothing changed since the last read.' : 'Nothing has happened yet.');
    return head.join('\n');
  }

  const lines: Array<{ text: string; section: string }> = [];
  for (const section of body) {
    lines.push({ text: `${section.title}:`, section: section.title });
    for (const line of section.lines) {
      for (const part of line.split('\n'))
        lines.push({ text: `  ${part}`, section: section.title });
    }
  }

  let out = head.join('\n');
  let used = out.length;
  let kept = 0;
  // Leave room for the note saying what was cut.
  const room = cap - 120;
  while (kept < lines.length && used + 1 + lines[kept].text.length <= room) {
    used += 1 + lines[kept].text.length;
    kept++;
  }
  out += `\n${lines
    .slice(0, kept)
    .map((l) => l.text)
    .join('\n')}`;
  if (kept < lines.length) {
    const cut = new Map<string, number>();
    for (const l of lines.slice(kept)) cut.set(l.section, (cut.get(l.section) ?? 0) + 1);
    const what = [...cut]
      .map(([title, n]) => `${title} (${n} line${n === 1 ? '' : 's'})`)
      .join(', ');
    out += `\n[cut to fit: ${what}]`;
  }
  return out;
}
