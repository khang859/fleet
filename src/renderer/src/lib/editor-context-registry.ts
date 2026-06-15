/**
 * Registry of editor handles for open file panes, so the Rune Quick-Assist overlay can read
 * the current selection and reconcile edits (reload / flash / revert) without per-keystroke
 * store churn. Mirrors file-save-registry.ts.
 */
import type { RuneAssistSelection } from '../../../shared/rune-assist';

export type EditorHandle = {
  /** Current selection as 1-based line numbers (from === to means just the cursor line). */
  getSelection: () => RuneAssistSelection;
  /** Current editor document text. */
  getContent: () => string;
  /** Reload the document from disk; returns the new content (or null on failure). */
  reloadFromDisk: () => Promise<string | null>;
  /** Briefly highlight the given 1-based inclusive line range. */
  flashLines: (range: RuneAssistSelection) => void;
  /** Overwrite the document + persist to disk (used by Revert). */
  writeContent: (content: string) => Promise<void>;
  /** Flush the current buffer to disk (used before an edit turn so rune reads the user's content). */
  save: () => Promise<void>;
  /** Absolute path of the file this pane is editing. */
  getFilePath: () => string;
  /** True when the buffer matches what's on disk (safe to reload without losing edits). */
  isClean: () => boolean;
  /**
   * Screen position of a document offset, relative to the pane wrapper, plus whether the
   * line is currently within the scroll viewport. Returns null when it can't be computed
   * (no view, or the offset is outside the rendered range). Used to keep the overlay
   * anchored to its line as the editor scrolls.
   */
  coordsForPos: (pos: number) => { top: number; left: number; visible: boolean } | null;
  /** Subscribe to editor scroll; returns an unsubscribe fn. */
  onScroll: (cb: () => void) => () => void;
};

const registry = new Map<string, EditorHandle>();

export function registerEditorHandle(paneId: string, handle: EditorHandle): void {
  registry.set(paneId, handle);
}

export function unregisterEditorHandle(paneId: string): void {
  registry.delete(paneId);
}

export function getEditorHandle(paneId: string): EditorHandle | undefined {
  return registry.get(paneId);
}

/** All registered handles editing the given absolute file path (usually 0 or 1). */
export function getEditorHandlesForFile(filePath: string): EditorHandle[] {
  const out: EditorHandle[] = [];
  for (const handle of registry.values()) {
    if (handle.getFilePath() === filePath) out.push(handle);
  }
  return out;
}
