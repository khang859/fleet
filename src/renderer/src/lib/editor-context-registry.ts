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
