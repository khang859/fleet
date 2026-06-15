// src/main/learnings/distiller.ts
// Distill a finished agent session into a draft learning via a headless one-shot
// agent run. We feed the transcript inline to the engine (`rune --prompt`) and
// capture stdout — agent-agnostic, no transcript re-parsing on the agent side.
// The engine is rune (Fleet's flagship agent) regardless of which agent produced
// the session; claude is only a fallback when rune is not installed.
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { createLogger } from '../logger';
import type { SessionAgent, SessionTranscript } from '../../shared/sessions';
import type { DistillResult } from '../../shared/learnings';

const log = createLogger('learnings-distiller');

const MAX_TRANSCRIPT_CHARS = 48_000;
const TIMEOUT_MS = 120_000;
const SENTINEL = 'NO_LEARNING';

// Distill always runs on rune first (flagship); claude is a fallback only when rune
// is missing from PATH. Using rune as the engine also sidesteps `claude -p`'s
// tool-use-in-print-mode behavior.
const ENGINE_ORDER: readonly SessionAgent[] = ['rune', 'claude'];
const NOT_INSTALLED = 'is not installed or not on PATH';

/** Flatten a transcript to plain text, truncating the middle of very long ones. */
export function serializeTranscript(t: SessionTranscript): string {
  const lines: string[] = [];
  for (const m of t.messages) {
    lines.push(`## ${m.role}`);
    for (const b of m.blocks) {
      if (b.type === 'text') lines.push(b.text);
      else if (b.type === 'tool_use') lines.push(`[tool: ${b.name} ${b.argsPreview}]`);
      else if (b.type === 'tool_result')
        lines.push(`[result${b.isError ? ' error' : ''}: ${b.output.slice(0, 1000)}]`);
      else lines.push('[image]');
    }
    lines.push('');
  }
  const text = lines.join('\n');
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  const head = text.slice(0, Math.floor(MAX_TRANSCRIPT_CHARS * 0.4));
  const tail = text.slice(text.length - Math.floor(MAX_TRANSCRIPT_CHARS * 0.6));
  return `${head}\n\n…[transcript truncated]…\n\n${tail}`;
}

function buildPrompt(t: SessionTranscript): string {
  return [
    'You are reviewing a past AI coding session to capture a durable, reusable engineering learning.',
    'Identify the single most valuable lesson — typically a mistake or bug, its root cause, and the fix, or a non-obvious gotcha worth remembering.',
    '',
    'Output rules (follow EXACTLY):',
    `- If the session was routine with nothing worth recording, output exactly "${SENTINEL}" and nothing else.`,
    '- Otherwise output ONE markdown note and nothing else (no preamble, no surrounding code fences):',
    '    - First line: "# <concise, specific title>"',
    '    - Then the body: short sections (Problem / Root cause / Fix / Lesson) as relevant.',
    '    - Optional final line: "Tags: tag1, tag2" (2-5 short lowercase tags).',
    'Be specific to what actually happened. Do not invent details not present in the session.',
    '',
    '--- SESSION TRANSCRIPT ---',
    serializeTranscript(t),
    '--- END TRANSCRIPT ---'
  ].join('\n');
}

/** Strip a single set of wrapping ``` fences the agent may have added. */
function stripCodeFence(text: string): string {
  const m = text.match(/^```[^\n]*\n([\s\S]*)\n```$/);
  return m ? m[1].trim() : text;
}

export function parseDraft(raw: string): DistillResult {
  const out = stripCodeFence(raw.trim());
  if (
    !out ||
    out === SENTINEL ||
    out.startsWith(`${SENTINEL}\n`) ||
    out.startsWith(`${SENTINEL} `)
  ) {
    return { status: 'nothing' };
  }
  const lines = out.split('\n');

  let titleIdx = lines.findIndex((l) => l.trim().startsWith('# '));
  let title: string;
  if (titleIdx >= 0) {
    title = lines[titleIdx].replace(/^#\s+/, '').trim();
  } else {
    titleIdx = lines.findIndex((l) => l.trim().length > 0);
    title = titleIdx >= 0 ? lines[titleIdx].trim() : '';
  }

  const tagIdx = lines.findIndex((l) => /^tags:/i.test(l.trim()));
  const tags =
    tagIdx >= 0
      ? lines[tagIdx]
          .replace(/^\s*tags:/i, '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const body = lines
    .filter((_, i) => i !== titleIdx && i !== tagIdx)
    .join('\n')
    .trim();

  if (!title && !body) return { status: 'nothing' };
  return { status: 'ok', draft: { title: title || 'Untitled learning', body, tags } };
}

async function runAgentOneShot(agent: SessionAgent, cwd: string, prompt: string): Promise<string> {
  const cmd = agent === 'rune' ? 'rune' : 'claude';
  const args = agent === 'rune' ? ['--prompt', prompt] : ['-p', prompt];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: process.env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Distill timed out after 120s'));
    }, TIMEOUT_MS);
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new Error(`${cmd} ${NOT_INSTALLED}`) : err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // Any non-zero (or null, e.g. killed) exit is a failure. We must NOT fall
      // through to parsing stdout: agents print error text to stdout on failure,
      // and parseDraft would happily turn "Error: rate limit exceeded" into a
      // "learning". Report the failure instead.
      if (code !== 0) {
        const detail = stderr.slice(0, 300) || stdout.slice(0, 300) || 'no output';
        reject(new Error(`${cmd} exited ${code ?? '?'}: ${detail}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function distillLearning(t: SessionTranscript): Promise<DistillResult> {
  const { cwd } = t.summary;
  // `spawn` reports a missing `cwd` as ENOENT — the same code as a missing binary —
  // so without this check a deleted session directory would be misreported as
  // "<engine> is not installed". Check up front for a clear, actionable message.
  if (!existsSync(cwd)) {
    return { status: 'error', message: `Session directory no longer exists: ${cwd}` };
  }
  const prompt = buildPrompt(t);
  let lastError = 'No distill engine available';
  // Try engines in order; only fall through to the next when the current one is
  // simply not installed (any real failure is reported as-is).
  for (const engine of ENGINE_ORDER) {
    try {
      const out = await runAgentOneShot(engine, cwd, prompt);
      return parseDraft(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes(NOT_INSTALLED)) {
        lastError = message;
        continue;
      }
      log.warn('distill failed', { engine, message });
      return { status: 'error', message };
    }
  }
  log.warn('distill failed — no engine installed', { lastError });
  return { status: 'error', message: lastError };
}
