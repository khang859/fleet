export type Position = {
  index: number;
  /** Epoch ms of the first navigation, or null until the talk has started. */
  timerStartedAt: number | null;
};

export function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, index));
}

/**
 * Move by `delta` sections, starting the timer on the first press.
 *
 * The timer starts even when the press cannot move - "prev" on the first
 * section, or any press on single-section notes - because the press is what
 * says the talk has begun.
 */
export function step(position: Position, delta: number, total: number, now: number): Position {
  return {
    index: clampIndex(position.index + delta, total),
    timerStartedAt: position.timerStartedAt ?? now
  };
}

const LEADING_MARKERS = /^(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/;

/** The first non-blank line of a section, without its Markdown list or heading marker. */
export function previewLine(section: string): string {
  const line = section.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim().replace(LEADING_MARKERS, '').trim();
}

export function toView(
  sections: string[],
  index: number
): { current: string; nextPreview: string | null } {
  return {
    current: index < sections.length ? sections[index] : '',
    nextPreview: index + 1 < sections.length ? previewLine(sections[index + 1]) : null
  };
}
