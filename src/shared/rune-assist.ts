// Pure, renderer-safe helpers for the Rune Quick-Assist overlay. No Node imports.
import type { TranscriptMessage } from './sessions';

export type RuneAssistMode = 'ask' | 'edit';
export type RuneAssistSelection = { fromLine: number; toLine: number };

/** Read-only instruction prepended in Ask mode so Rune answers without writing to disk. */
export const ASK_PREAMBLE =
  'Answer the following question about the code. Do NOT edit, write, or create any ' +
  'files — respond with an explanation only.';

const IMPERATIVE_RE =
  /^\s*(finish|implement|complete|refactor|add|rename|fix|write|create|remove|delete|replace|update|change|make|generate|extract|inline|convert|move|sort|format|optimi[sz]e|simplify|wrap|split|merge|document|comment|annotate)\b/i;

/** Heuristic: a leading imperative verb => edit; otherwise ask. Authoritative mode is the caller's. */
export function detectIntent(text: string): RuneAssistMode {
  if (/\?\s*$/.test(text)) return 'ask';
  return IMPERATIVE_RE.test(text) ? 'edit' : 'ask';
}

/** Machine-readable context line prepended to every prompt. Rune reads the file itself. */
export function buildContextLine(
  filePath: string,
  selection: RuneAssistSelection | undefined
): string {
  if (!selection) return `[context: file ${filePath}]`;
  if (selection.fromLine === selection.toLine) {
    return `[context: file ${filePath}, line ${selection.fromLine}]`;
  }
  return `[context: file ${filePath}, lines ${selection.fromLine}-${selection.toLine} selected]`;
}

/** Final prompt body: optional read-only preamble, the context line, then the user's text. */
export function composeAssistPrompt(
  mode: RuneAssistMode,
  contextLine: string,
  text: string
): string {
  const head = mode === 'ask' ? `${ASK_PREAMBLE}\n\n` : '';
  return `${head}${contextLine}\n\n${text}`;
}

/** rune CLI args: `--prompt <body>` on the first turn, plus `--resume <id>` thereafter. */
export function buildAssistArgs(prompt: string, sessionId: string | null): string[] {
  const args = ['--prompt', prompt];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

/** Parse the `session-id: <id>` line rune prints on stdout. */
export function parseRuneSessionId(output: string): string | null {
  return /^session-id: ([A-Za-z0-9_-]+)$/m.exec(output)?.[1] ?? null;
}

/** The tool name from the LAST `[tool: <name>]` marker rune prints on stdout, or null. */
export function parseLatestToolStep(output: string): string | null {
  let last: string | null = null;
  const re = /\[tool: ([^\]]+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) last = m[1].trim();
  return last;
}

/** Human-readable progress label for a rune tool name (shown in the working pill). */
export function describeRuneStep(tool: string): string {
  switch (tool) {
    case 'read':
      return 'reading…';
    case 'list_files':
      return 'listing files…';
    case 'search_files':
      return 'searching…';
    case 'edit':
    case 'write':
      return 'editing…';
    case 'bash':
      return 'running a command…';
    case 'gh':
    case 'git_diff':
    case 'git_status':
      return 'checking git…';
    case 'spawn_subagent':
      return 'delegating…';
    case 'web_fetch':
    case 'web_search':
      return 'searching the web…';
    default:
      return `${tool}…`;
  }
}

/** Concatenated text of the last assistant message — the Ask answer. */
export function lastAssistantText(messages: TranscriptMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    const text = m.blocks
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('')
      .trim();
    if (text) return text;
  }
  return '';
}

// Tool-call names that indicate a file write. NOTE: tune against a real rune session JSON
// during the manual smoke (Task 10) — rune's exact write-tool names drive multi-file reload.
const WRITE_TOOL_RE = /(write|edit|create|replace|patch|append)/i;
const PATH_KEYS = ['path', 'file_path', 'filepath', 'filename', 'file'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Best-effort list of files rune wrote, from write-like tool calls. Active-pane reload does
 * not depend on this (see store reconcile) — this only reloads *other* already-open panes. */
export function extractChangedFiles(messages: TranscriptMessage[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of messages) {
    for (const b of m.blocks) {
      if (b.type !== 'tool_use' || !WRITE_TOOL_RE.test(b.name)) continue;
      let args: unknown;
      try {
        args = JSON.parse(b.argsPreview);
      } catch {
        continue;
      }
      if (!isRecord(args)) continue;
      for (const key of PATH_KEYS) {
        const v = args[key];
        if (typeof v === 'string' && v && !seen.has(v)) {
          seen.add(v);
          out.push(v);
          break;
        }
      }
    }
  }
  return out;
}

/** 1-based inclusive range of lines that differ between two file contents, or null if identical. */
export function changedLineRange(before: string, after: string): RuneAssistSelection | null {
  if (before === after) return null;
  const a = before.split('\n');
  const b = after.split('\n');
  let top = 0;
  while (top < a.length && top < b.length && a[top] === b[top]) top++;
  let bottom = 0;
  while (
    bottom < a.length - top &&
    bottom < b.length - top &&
    a[a.length - 1 - bottom] === b[b.length - 1 - bottom]
  ) {
    bottom++;
  }
  const lines = b.length || 1;
  const fromLine = Math.min(top + 1, lines);
  const toLine = Math.max(fromLine, Math.min(b.length - bottom, lines));
  return { fromLine, toLine };
}

export type OverlayClampInput = {
  /** Desired position of the overlay box's top-left, relative to the layer. */
  rawTop: number;
  rawLeft: number;
  /** Size of the containing layer (the editor pane). */
  layerWidth: number;
  layerHeight: number;
  /** Size of the overlay box being positioned. */
  boxWidth: number;
  boxHeight: number;
  /** Minimum gap to keep between the box and the layer edges. */
  pad: number;
};

/**
 * Clamp an overlay box so it stays fully inside its layer with `pad` breathing room.
 * When the layer is smaller than the box + padding, the box is pinned at `pad` (top-left)
 * rather than pushed off the opposite edge.
 */
export function clampOverlayPosition(i: OverlayClampInput): { top: number; left: number } {
  const maxLeft = Math.max(i.pad, i.layerWidth - i.boxWidth - i.pad);
  const maxTop = Math.max(i.pad, i.layerHeight - i.boxHeight - i.pad);
  return {
    top: Math.min(Math.max(i.pad, i.rawTop), maxTop),
    left: Math.min(Math.max(i.pad, i.rawLeft), maxLeft)
  };
}
