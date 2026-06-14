import { create } from 'zustand';
import { detectIntent, changedLineRange } from '../../../shared/rune-assist';
import type { RuneAssistMode } from '../../../shared/rune-assist';
import { getEditorHandle } from '../lib/editor-context-registry';
import type { RuneAssistResultPayload, RuneAssistStatusPayload } from '../../../shared/ipc-api';

type Phase = 'idle' | 'working' | 'error';

type PaneAssist = {
  open: boolean;
  anchor: { top: number; left: number } | null;
  draft: string;
  phase: Phase;
  step: string | null;
  error: string | null;
  /** Last Ask answer; when set and phase==='idle', the popover is shown. */
  answer: string | null;
  /** Pre-turn content snapshot for one-click Revert (Edit turns only). */
  editSnapshot: string | null;
  /** True after a successful Edit turn lands — drives the "⟳ Reloaded · Revert" affordance. */
  lastEdited: boolean;
  cwd: string;
  contextFile: string;
  modeOverride: RuneAssistMode | null;
};

type OpenArgs = { cwd: string; contextFile: string; anchor: { top: number; left: number } };

type PaneMap = Record<string, PaneAssist | undefined>;

type StoreState = {
  panes: PaneMap;
  openOverlay: (paneId: string, args: OpenArgs) => void;
  closeOverlay: (paneId: string) => void;
  setDraft: (paneId: string, draft: string) => void;
  setModeOverride: (paneId: string, mode: RuneAssistMode) => void;
  dismissAnswer: (paneId: string) => void;
  send: (paneId: string, text: string) => Promise<void>;
  stop: (paneId: string) => Promise<void>;
  revert: (paneId: string) => Promise<void>;
  applyStatus: (
    paneId: string,
    payload: Pick<RuneAssistStatusPayload, 'phase' | 'step' | 'error'>
  ) => void;
  applyResult: (paneId: string, payload: RuneAssistResultPayload) => void;
  /** Pane permanently closed: cancel any in-flight turn for it and drop its state. */
  disposePane: (paneId: string) => void;
};

function blank(cwd: string, contextFile: string, anchor: OpenArgs['anchor']): PaneAssist {
  return {
    open: true,
    anchor,
    draft: '',
    phase: 'idle',
    step: null,
    error: null,
    answer: null,
    editSnapshot: null,
    lastEdited: false,
    cwd,
    contextFile,
    modeOverride: null
  };
}

function patch(
  state: StoreState,
  paneId: string,
  fn: (p: PaneAssist) => PaneAssist
): { panes: PaneMap } {
  const existing = state.panes[paneId];
  if (!existing) return { panes: state.panes };
  return { panes: { ...state.panes, [paneId]: fn(existing) } };
}

export const useRuneAssistStore = create<StoreState>((set, get) => ({
  panes: {},

  openOverlay: (paneId, { cwd, contextFile, anchor }) =>
    set((s) => ({
      panes: { ...s.panes, [paneId]: blank(cwd, contextFile, anchor) }
    })),

  closeOverlay: (paneId) => set((s) => patch(s, paneId, (p) => ({ ...p, open: false }))),

  setDraft: (paneId, draft) => set((s) => patch(s, paneId, (p) => ({ ...p, draft }))),

  setModeOverride: (paneId, mode) =>
    set((s) => patch(s, paneId, (p) => ({ ...p, modeOverride: mode }))),

  dismissAnswer: (paneId) => set((s) => patch(s, paneId, (p) => ({ ...p, answer: null }))),

  send: async (paneId, text) => {
    const body = text.trim();
    if (!body) return;
    const p = get().panes[paneId];
    if (!p || p.phase === 'working') return; // one in-flight per pane (main also guards per cwd)

    const mode = p.modeOverride ?? detectIntent(body);
    const handle = getEditorHandle(paneId);
    const selection = handle?.getSelection();
    if (mode === 'edit') await handle?.save();
    const snapshot = mode === 'edit' ? (handle?.getContent() ?? null) : null;

    set((s) =>
      patch(s, paneId, (cur) => ({
        ...cur,
        open: false,
        draft: body,
        phase: 'working',
        step: 'thinking…',
        error: null,
        answer: null,
        lastEdited: false,
        editSnapshot: snapshot
      }))
    );

    try {
      await window.fleet.runeAssist.send({
        cwd: p.cwd,
        paneId,
        text: body,
        mode,
        contextFile: p.contextFile,
        selection
      });
    } catch (err) {
      set((s) =>
        patch(s, paneId, (cur) => ({
          ...cur,
          open: true,
          phase: 'error',
          error: err instanceof Error ? err.message : String(err)
        }))
      );
    }
  },

  stop: async (paneId) => {
    const p = get().panes[paneId];
    if (!p) return;
    await window.fleet.runeAssist.stop({ cwd: p.cwd, paneId });
  },

  revert: async (paneId) => {
    const editSnapshot = get().panes[paneId]?.editSnapshot;
    if (editSnapshot == null) return;
    const handle = getEditorHandle(paneId);
    await handle?.writeContent(editSnapshot);
    set((s) => patch(s, paneId, (cur) => ({ ...cur, lastEdited: false, editSnapshot: null })));
  },

  applyStatus: (paneId, payload) =>
    set((s) =>
      patch(s, paneId, (p) => ({
        ...p,
        open: payload.phase === 'error' ? true : p.open,
        phase: payload.phase,
        step: payload.step ?? (payload.phase === 'error' ? null : p.step),
        error: payload.phase === 'error' ? (payload.error ?? 'something went wrong') : null
      }))
    ),

  applyResult: (paneId, payload) => {
    // Ask: show the answer popover. Edit: reconcile the editor (reload + flash) and arm Revert.
    if (payload.mode === 'ask') {
      set((s) =>
        patch(s, paneId, (p) => ({ ...p, phase: 'idle', step: null, answer: payload.answer ?? '' }))
      );
      return;
    }
    const p = get().panes[paneId];
    const handle = getEditorHandle(paneId);
    const before = p?.editSnapshot;
    if (handle) {
      void handle
        .reloadFromDisk()
        .then((after) => {
          if (after !== null && before != null) {
            const range = changedLineRange(before, after);
            if (range) handle.flashLines(range);
          }
        })
        .catch(() => {
          // reload failed (file deleted / FS error); flash is best-effort, ignore
        });
    }
    set((s) =>
      patch(s, paneId, (cur) => ({ ...cur, phase: 'idle', step: null, lastEdited: true }))
    );
  },

  disposePane: (paneId) => {
    const p = get().panes[paneId];
    if (!p) return;
    if (p.phase === 'working') {
      void window.fleet.runeAssist.stop({ cwd: p.cwd, paneId });
    }
    set((s) => {
      if (!s.panes[paneId]) return { panes: s.panes };
      const next = { ...s.panes };
      delete next[paneId];
      return { panes: next };
    });
  }
}));
