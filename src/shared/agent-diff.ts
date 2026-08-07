/**
 * Line diffs, in the one format everything already understands.
 *
 * An edit produces exactly two artefacts: what to tell the model it did, and
 * what to show the user. They are the same thing written twice unless they are
 * the same string, so this produces unified diff text and the pane renders that
 * text rather than a parallel structure that can disagree with it.
 *
 * Unified, and not line numbers plus a description, because a diff is the one
 * representation of a change that every model has read millions of, and the one
 * a person can check at a glance.
 */

export type DiffOp = { kind: 'context' | 'add' | 'remove'; text: string };

export type DiffHunk = {
  /** 1-indexed first line of the hunk in each side. */
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: DiffOp[];
};

/** Unchanged lines kept around a change, so a hunk can be read on its own. */
export const DIFF_CONTEXT_LINES = 3;

/**
 * Changes one diff will chase before it gives up and calls the whole middle a
 * replacement. Myers' algorithm costs O((n+m)·d) time and keeps a snapshot per
 * step, so the ceiling is what stops a pathological pair of files from spending
 * a second and a hundred megabytes to describe "this is now something else".
 */
const MAX_EDIT_DISTANCE = 600;

/** Split into lines the way a diff counts them: a trailing newline ends the last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * The line-by-line difference between two texts.
 *
 * Common head and tail are matched off first. That is not only an optimization:
 * one edit in a long file leaves a handful of lines in the middle for the
 * expensive part, which is what keeps the ceiling above from ever being reached
 * by a real edit.
 */
export function diffLines(beforeText: string, afterText: string): DiffOp[] {
  const before = splitLines(beforeText);
  const after = splitLines(afterText);

  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++;
  }

  const middleBefore = before.slice(head, before.length - tail);
  const middleAfter = after.slice(head, after.length - tail);

  return [
    ...before.slice(0, head).map((text) => ({ kind: 'context' as const, text })),
    ...(middle(middleBefore, middleAfter) ?? replaceBlock(middleBefore, middleAfter)),
    ...before.slice(before.length - tail).map((text) => ({ kind: 'context' as const, text }))
  ];
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
  return {
    added: ops.filter((op) => op.kind === 'add').length,
    removed: ops.filter((op) => op.kind === 'remove').length
  };
}

/**
 * The changed parts of a diff, each with a few unchanged lines around it.
 *
 * Whole-file output would be honest but unreadable: the change is the point,
 * and the lines either side of it are what make the change legible.
 */
export function toHunks(ops: DiffOp[], context = DIFF_CONTEXT_LINES): DiffHunk[] {
  const changed = ops.map((op) => op.kind !== 'context');
  const hunks: DiffHunk[] = [];

  // Where each op sits on both sides, so a hunk header can say where it starts.
  const beforeAt: number[] = [];
  const afterAt: number[] = [];
  let beforeLine = 1;
  let afterLine = 1;
  for (const op of ops) {
    beforeAt.push(beforeLine);
    afterAt.push(afterLine);
    if (op.kind !== 'add') beforeLine++;
    if (op.kind !== 'remove') afterLine++;
  }

  let i = 0;
  while (i < ops.length) {
    if (!changed[i]) {
      i++;
      continue;
    }
    // Grow the hunk while the next change is close enough that the context
    // around the two would overlap - two hunks a line apart read as one.
    const from = Math.max(0, i - context);
    let to = i;
    for (;;) {
      const next = changed.indexOf(true, to + 1);
      if (next === -1 || next - to > context * 2) break;
      to = next;
    }
    to = Math.min(ops.length - 1, to + context);

    const lines = ops.slice(from, to + 1);
    hunks.push({
      beforeStart: beforeAt[from],
      beforeCount: lines.filter((op) => op.kind !== 'add').length,
      afterStart: afterAt[from],
      afterCount: lines.filter((op) => op.kind !== 'remove').length,
      lines
    });
    i = to + 1;
  }
  return hunks;
}

/**
 * Hunks as unified diff text, cut at `maxLines` with what was cut said out loud.
 * A diff the reader believes is the whole change would be worse than no diff.
 */
export function formatUnified(hunks: DiffHunk[], maxLines: number): string {
  const out: string[] = [];
  let budget = maxLines;
  let dropped = 0;

  for (const hunk of hunks) {
    if (budget <= 0) {
      dropped += hunk.lines.length;
      continue;
    }
    out.push(
      `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@`
    );
    for (const line of hunk.lines) {
      if (budget <= 0) {
        dropped++;
        continue;
      }
      out.push(`${sign(line.kind)}${line.text}`);
      budget--;
    }
  }

  if (dropped > 0) out.push(`… ${dropped} more changed lines not shown`);
  return out.join('\n');
}

function sign(kind: DiffOp['kind']): string {
  if (kind === 'add') return '+';
  return kind === 'remove' ? '-' : ' ';
}

/** What a line of unified diff text is, for rendering it back. */
export function diffLineKind(line: string): DiffOp['kind'] | 'hunk' | 'note' {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'remove';
  if (line.startsWith(' ')) return 'context';
  return 'note';
}

/** Every line removed and every line added, when the two sides share nothing worth aligning. */
function replaceBlock(before: string[], after: string[]): DiffOp[] {
  return [
    ...before.map((text) => ({ kind: 'remove' as const, text })),
    ...after.map((text) => ({ kind: 'add' as const, text }))
  ];
}

/**
 * Myers' shortest-edit-script diff, or null when the two sides differ by more
 * than the ceiling. Walks diagonals furthest-reaching first and keeps one
 * snapshot per step, which the backtrack turns into the ops.
 */
function middle(a: string[], b: string[]): DiffOp[] | null {
  if (a.length === 0) return b.map((text) => ({ kind: 'add' as const, text }));
  if (b.length === 0) return a.map((text) => ({ kind: 'remove' as const, text }));

  const maxD = Math.min(a.length + b.length, MAX_EDIT_DISTANCE);
  const offset = maxD;
  const v = new Int32Array(2 * maxD + 1);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      // Reach this diagonal from whichever neighbour got further: down when it
      // is ahead or when there is no left neighbour, right otherwise.
      const down = k === -d || (k !== d && v[k - 1 + offset] < v[k + 1 + offset]);
      let x = down ? v[k + 1 + offset] : v[k - 1 + offset] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x++;
        y++;
      }
      v[k + offset] = x;
      if (x >= a.length && y >= b.length) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

function backtrack(
  trace: Int32Array[],
  a: string[],
  b: string[],
  d: number,
  offset: number
): DiffOp[] {
  const ops: DiffOp[] = [];
  let x = a.length;
  let y = b.length;

  for (let step = d; step > 0; step--) {
    const v = trace[step];
    const k = x - y;
    const down = k === -step || (k !== step && v[k - 1 + offset] < v[k + 1 + offset]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = v[prevK + offset];
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ kind: 'context', text: a[x] });
    }
    if (x > prevX) {
      x--;
      ops.push({ kind: 'remove', text: a[x] });
    } else {
      y--;
      ops.push({ kind: 'add', text: b[y] });
    }
  }

  while (x > 0) {
    x--;
    y--;
    ops.push({ kind: 'context', text: a[x] });
  }
  return ops.reverse();
}
