import type { BoardItem } from '../../shared/workflows';

/** Two findings this many lines apart in one file count as the same place. */
const SAME_PLACE_LINES = 5;

export type NewItem = {
  kind: string;
  text: string;
  file?: string;
  line?: number;
  source?: string;
};

/** Text with case, punctuation and extra space removed, so small edits still match. */
export function cleanText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The rule from the design doc: by place for code, by source for a note, or by text. */
export function isRepeat(item: NewItem, existing: BoardItem): boolean {
  if (item.file !== undefined && existing.file !== undefined) {
    const close = Math.abs((item.line ?? 0) - (existing.line ?? 0)) <= SAME_PLACE_LINES;
    return (
      item.file === existing.file && close && cleanText(item.kind) === cleanText(existing.kind)
    );
  }
  if (item.source !== undefined && existing.source !== undefined) {
    return item.source === existing.source && cleanText(item.text) === cleanText(existing.text);
  }
  if (item.file !== undefined || item.source !== undefined) return false;
  if (existing.file !== undefined || existing.source !== undefined) return false;
  return cleanText(item.text) === cleanText(existing.text);
}

export type AddResult = { added: true; item: BoardItem } | { added: false; existing: BoardItem };

/** The shared board of one run. It holds the rules; the store keeps it on disk. */
export class Board {
  private next: number;

  constructor(private readonly items: BoardItem[] = []) {
    this.next = items.reduce((most, item) => Math.max(most, Number(item.id)), 0) + 1;
  }

  /** Items that count: a merged item replaces the items it came from. */
  list(): BoardItem[] {
    return this.items.filter((item) => item.mergedInto === undefined);
  }

  all(): BoardItem[] {
    return this.items;
  }

  get(id: string): BoardItem | undefined {
    return this.items.find((item) => item.id === id);
  }

  /** Add an item, or return the item that it repeats so the agent can read it. */
  add(agent: string, item: NewItem): AddResult {
    const existing = this.list().find((other) => isRepeat(item, other));
    if (existing) return { added: false, existing };
    const added: BoardItem = { ...item, id: String(this.next++), agent };
    this.items.push(added);
    return { added: true, item: added };
  }

  /** Replace some items with one. Their sources stay in `mergedFrom`. */
  merge(agent: string, ids: string[], item: NewItem): BoardItem {
    const sources = ids.map((id) => this.get(id));
    const missing = ids.filter((_, index) => !sources[index]);
    if (missing.length > 0) throw new Error(`No item with id ${missing.join(', ')}.`);

    const merged: BoardItem = { ...item, id: String(this.next++), agent, mergedFrom: ids };
    for (const source of sources) if (source) source.mergedInto = merged.id;
    this.items.push(merged);
    return merged;
  }
}

/** The board as plain text, for a report with no summary to go on. */
export function boardText(items: BoardItem[]): string {
  return items
    .map((item) => {
      const place = item.file ? ` (${item.file}${item.line ? `:${item.line}` : ''})` : '';
      const source = item.source ? ` Source: ${item.source}` : '';
      return `- **${item.kind}**${place}: ${item.text}${source}`;
    })
    .join('\n');
}
