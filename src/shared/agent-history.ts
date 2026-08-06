import { z } from 'zod';

/**
 * The prompts you have typed, and walking back through them.
 *
 * Two halves that both live here because they have to agree: the shape on disk,
 * which main writes and reads, and the cycling itself, which is the renderer's
 * but is pure and worth testing without a DOM.
 *
 * The cycling is the part people notice. Every reported complaint about this
 * feature in other harnesses is the same one - "Up ate my draft" - so the rule
 * here is that nothing you typed can be lost by pressing a key: the draft is
 * set aside on the way back and put in front of you again on the way forward,
 * and editing a recalled prompt makes *that* the draft rather than something
 * the next Up can overwrite.
 */

/** One prompt, as it went to the model, with the folder it was typed against. */
export const AgentHistoryEntry = z.object({
  text: z.string(),
  cwd: z.string(),
  at: z.number()
});
export type AgentHistoryEntry = z.infer<typeof AgentHistoryEntry>;

/**
 * How many prompts a folder keeps.
 *
 * Per folder rather than in total, because a folder is the unit you recall
 * from - a cap on the whole file would let a busy repo push a quiet one out.
 */
export const HISTORY_LIMIT = 100;

/**
 * What Up walks through: newest first, each distinct prompt once.
 *
 * Collapsed on the way out rather than on the way in. A writer that refuses
 * duplicates still cannot promise a clean file - it may have been written by an
 * older build, or by two windows at once - so the reader is the side that has
 * to be right about it. Keeping the newest occurrence is what makes a prompt
 * you use every day stay one press away instead of sinking.
 */
export function recallable(entries: AgentHistoryEntry[], cwd: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.cwd !== cwd) continue;
    if (entry.text === '' || seen.has(entry.text)) continue;
    seen.add(entry.text);
    out.push(entry.text);
    if (out.length === HISTORY_LIMIT) break;
  }
  return out;
}

/**
 * Where the walk has got to.
 *
 * `index` is `null` when the box holds live text rather than a recalled prompt,
 * which is both the starting state and the one Down comes back to.
 */
export interface AgentHistoryCursor {
  index: number | null;
  /** What was in the box when the walk began, waiting to be handed back. */
  draft: string;
}

export const HISTORY_IDLE: AgentHistoryCursor = { index: null, draft: '' };

export type HistoryDirection = 'back' | 'forward';

/**
 * One press. `null` means the press was not ours - there is nowhere further to
 * go - and the caller should leave the key alone rather than swallow it.
 *
 * Going back off the oldest entry stops there rather than wrapping: wrapping
 * round to the newest reads as the list having reset, and there is no way to
 * tell the two apart from the box.
 */
export function historyStep(
  cursor: AgentHistoryCursor,
  direction: HistoryDirection,
  entries: string[],
  current: string
): { cursor: AgentHistoryCursor; text: string } | null {
  if (direction === 'back') {
    const next = cursor.index === null ? 0 : cursor.index + 1;
    if (next >= entries.length) return null;
    // The draft is taken at the first step and then left alone, so a walk of
    // any length still has the same text waiting at the end of it.
    const draft = cursor.index === null ? current : cursor.draft;
    return { cursor: { index: next, draft }, text: entries[next] };
  }
  if (cursor.index === null) return null;
  if (cursor.index === 0) return { cursor: { index: null, draft: '' }, text: cursor.draft };
  return {
    cursor: { index: cursor.index - 1, draft: cursor.draft },
    text: entries[cursor.index - 1]
  };
}
