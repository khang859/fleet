import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState, StateEffect, StateField, type Range } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine,
  Decoration,
  type DecorationSet
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, LanguageSupport } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { getLanguageForPath } from '../../../shared/languages';
import { useWorkspaceStore } from '../store/workspace-store';
import { registerFileSave, unregisterFileSave } from '../lib/file-save-registry';
import { PathChromeHeader } from './PathChromeHeader';
import {
  registerEditorHandle,
  unregisterEditorHandle,
  type EditorHandle
} from '../lib/editor-context-registry';
import { useRuneAssistStore } from '../store/rune-assist-store';
import { RuneAssistLayer } from './rune-assist/RuneAssistLayer';
import type { PaneNode } from '../../../shared/types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const AUTO_SAVE_DELAY = 3000; // 3 seconds

// --- Rune flash: transient line highlight after an Agent edit ---
const flashRangeEffect = StateEffect.define<{ fromLine: number; toLine: number } | null>();

const flashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(flashRangeEffect)) continue;
      if (e.value === null) {
        next = Decoration.none;
        continue;
      }
      const ranges: Array<Range<Decoration>> = [];
      const { fromLine, toLine } = e.value;
      for (let ln = fromLine; ln <= toLine && ln <= tr.state.doc.lines; ln++) {
        const line = tr.state.doc.line(ln);
        ranges.push(Decoration.line({ class: 'rune-flash-line' }).range(line.from));
      }
      next = Decoration.set(ranges, true);
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f)
});

/** True if the given pane id appears anywhere in this split tree. */
function treeContainsPane(node: PaneNode, paneId: string): boolean {
  if (node.type === 'leaf') return node.id === paneId;
  return treeContainsPane(node.children[0], paneId) || treeContainsPane(node.children[1], paneId);
}

async function loadCodeMirrorLanguage(langId: string): Promise<LanguageSupport | null> {
  switch (langId) {
    case 'javascript':
      return import('@codemirror/lang-javascript').then((m) => m.javascript());
    case 'jsx':
      return import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true }));
    case 'typescript':
      return import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true }));
    case 'tsx':
      return import('@codemirror/lang-javascript').then((m) =>
        m.javascript({ typescript: true, jsx: true })
      );
    case 'html':
      return import('@codemirror/lang-html').then((m) => m.html());
    case 'css':
      return import('@codemirror/lang-css').then((m) => m.css());
    case 'less':
    case 'scss':
      return import('@codemirror/lang-sass').then((m) => m.sass());
    case 'json':
      return import('@codemirror/lang-json').then((m) => m.json());
    case 'markdown':
      return import('@codemirror/lang-markdown').then((m) => m.markdown());
    case 'python':
      return import('@codemirror/lang-python').then((m) => m.python());
    case 'rust':
      return import('@codemirror/lang-rust').then((m) => m.rust());
    case 'go':
      return import('@codemirror/lang-go').then((m) => m.go());
    case 'java':
    case 'kotlin':
      return import('@codemirror/lang-java').then((m) => m.java());
    case 'c':
    case 'cpp':
      return import('@codemirror/lang-cpp').then((m) => m.cpp());
    case 'xml':
      return import('@codemirror/lang-xml').then((m) => m.xml());
    case 'sql':
      return import('@codemirror/lang-sql').then((m) => m.sql());
    case 'php':
      return import('@codemirror/lang-php').then((m) => m.php());
    case 'vue':
      return import('@codemirror/lang-vue').then((m) => m.vue());
    case 'yaml':
      return import('@codemirror/lang-yaml').then((m) => m.yaml());
    case 'bash': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { shell } = await import('@codemirror/legacy-modes/mode/shell');
      return new LanguageSupport(StreamLanguage.define(shell));
    }
    case 'dockerfile': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { dockerFile } = await import('@codemirror/legacy-modes/mode/dockerfile');
      return new LanguageSupport(StreamLanguage.define(dockerFile));
    }
    case 'toml': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { toml } = await import('@codemirror/legacy-modes/mode/toml');
      return new LanguageSupport(StreamLanguage.define(toml));
    }
    case 'ruby': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { ruby } = await import('@codemirror/legacy-modes/mode/ruby');
      return new LanguageSupport(StreamLanguage.define(ruby));
    }
    case 'lua': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { lua } = await import('@codemirror/legacy-modes/mode/lua');
      return new LanguageSupport(StreamLanguage.define(lua));
    }
    case 'swift': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { swift } = await import('@codemirror/legacy-modes/mode/swift');
      return new LanguageSupport(StreamLanguage.define(swift));
    }
    case 'makefile': {
      const { StreamLanguage } = await import('@codemirror/language');
      const { cmake } = await import('@codemirror/legacy-modes/mode/cmake');
      return new LanguageSupport(StreamLanguage.define(cmake));
    }
    case 'svelte':
      return import('@codemirror/lang-html').then((m) => m.html());
    case 'zig':
      return import('@codemirror/lang-cpp').then((m) => m.cpp());
    default:
      return null;
  }
}

function getLanguageName(filePath: string): string {
  return getLanguageForPath(filePath)?.label ?? 'Plain Text';
}

type Props = {
  paneId: string;
  filePath: string;
  onContentChange?: (content: string) => void;
  /** When false, hides the built-in path header + footer path — used when the host pane renders its own chrome. */
  showPathChrome?: boolean;
};

export function FileEditorPane({
  paneId,
  filePath,
  onContentChange,
  showPathChrome = true
}: Props): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [isSaving, setIsSaving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedContentRef = useRef<string>('');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialContentRef = useRef<string | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openRuneOverlayRef = useRef<(anchor: { top: number; left: number }) => void>(() => {});
  const runeWorkingRef = useRef(false);

  const setPaneDirty = useWorkspaceStore((s) => s.setPaneDirty);
  const openOverlay = useRuneAssistStore((s) => s.openOverlay);
  const runeWorking = useRuneAssistStore((s) => s.panes[paneId]?.phase === 'working');
  runeWorkingRef.current = runeWorking;
  // The workspace cwd that owns this pane (rune runs there).
  const cwd = useWorkspaceStore((s) => {
    const tab = s.workspace.tabs.find((t) => treeContainsPane(t.splitRoot, paneId));
    return tab?.cwd ?? '/';
  });
  openRuneOverlayRef.current = (anchor) =>
    openOverlay(paneId, { cwd, contextFile: filePath, anchor });

  const save = useCallback(async () => {
    if (!viewRef.current) return;
    setIsSaving(true);
    const content = viewRef.current.state.doc.toString();
    const result = await window.fleet.file.write(filePath, content);
    setIsSaving(false);
    if (result.success) {
      savedContentRef.current = content;
      // Re-check if editor content changed during the async write
      const currentContent = viewRef.current?.state.doc.toString();
      const stillDirty = currentContent !== undefined && currentContent !== content;
      if (!stillDirty) {
        setIsDirty(false);
        setPaneDirty(paneId, false);
        if (autoSaveTimerRef.current) {
          clearTimeout(autoSaveTimerRef.current);
          autoSaveTimerRef.current = null;
        }
      }
    }
  }, [filePath, paneId, setPaneDirty]);

  // Keep saveRef current so closures in EditorView always call the latest save
  const saveRef = useRef(save);
  saveRef.current = save;

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  // Load file on mount
  useEffect(() => {
    void window.fleet.file.read(filePath).then((result) => {
      if (result.success && result.data) {
        if (result.data.size > MAX_FILE_SIZE) {
          setTooLarge(true);
          setFileSize(result.data.size);
        } else {
          initialContentRef.current = result.data.content;
        }
      } else {
        setError(('error' in result ? result.error : undefined) ?? 'Failed to read file');
      }
      setLoading(false);
    });
  }, [filePath]);

  // Create editor once file is loaded
  useEffect(() => {
    if (loading || tooLarge || error !== null || initialContentRef.current === null) return;
    if (!containerRef.current) return;

    const content = initialContentRef.current;
    savedContentRef.current = content;

    const langInfo = getLanguageForPath(filePath);

    const view = new EditorView({
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          highlightActiveLine(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          search(),
          flashField,
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void saveRef.current();
                return true;
              }
            },
            {
              key: 'Mod-i',
              run: (view) => {
                const sel = view.state.selection.main;
                const coords = view.coordsAtPos(sel.head);
                const host = containerRef.current?.getBoundingClientRect();
                const anchor =
                  coords && host
                    ? { top: coords.bottom - host.top, left: coords.left - host.left }
                    : { top: 8, left: 8 };
                openRuneOverlayRef.current(anchor);
                return true;
              }
            },
            indentWithTab,
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap
          ]),
          oneDark,
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const current = update.state.doc.toString();
            const dirty = current !== savedContentRef.current;
            setIsDirty(dirty);
            onContentChangeRef.current?.(current);
            setPaneDirty(paneId, dirty);
            if (dirty && !runeWorkingRef.current) {
              if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
              autoSaveTimerRef.current = setTimeout(() => {
                void saveRef.current();
              }, AUTO_SAVE_DELAY);
            }
          }),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) {
              const head = update.state.selection.main.head;
              const line = update.state.doc.lineAt(head);
              setCursorPos({ line: line.number, col: head - line.from + 1 });
            }
          }),
          EditorView.theme({
            '&': { height: '100%' },
            '.cm-scroller': { overflow: 'auto' },
            '.rune-flash-line': {
              backgroundColor: 'rgba(152, 195, 121, 0.18)',
              transition: 'background-color 1.2s ease-out'
            }
          })
        ]
      }),
      parent: containerRef.current
    });

    viewRef.current = view;

    // Lazy-load and apply syntax highlighting
    if (langInfo) {
      void loadCodeMirrorLanguage(langInfo.id).then((langExt) => {
        if (langExt && viewRef.current === view) {
          view.dispatch({
            effects: StateEffect.appendConfig.of(langExt)
          });
        }
      });
    }

    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, tooLarge, error]);

  // Register save function so the close dialog can trigger it
  useEffect(() => {
    registerFileSave(paneId, async () => saveRef.current());
    return () => unregisterFileSave(paneId);
  }, [paneId]);

  // Don't let a pending auto-save fire into a file rune is editing.
  useEffect(() => {
    if (runeWorking && autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }
  }, [runeWorking]);

  // Register editor handle so Rune overlay can read selection, flash lines, and sync content
  useEffect(() => {
    const handle: EditorHandle = {
      getSelection: () => {
        const view = viewRef.current;
        if (!view) return { fromLine: 1, toLine: 1 };
        const sel = view.state.selection.main;
        return {
          fromLine: view.state.doc.lineAt(sel.from).number,
          toLine: view.state.doc.lineAt(sel.to).number
        };
      },
      getContent: () => viewRef.current?.state.doc.toString() ?? '',
      reloadFromDisk: async () => {
        const res = await window.fleet.file.read(filePath);
        if (!res.success) return null;
        const view = viewRef.current;
        if (!view) return null;
        const content = res.data.content;
        savedContentRef.current = content;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        return content;
      },
      flashLines: (range) => {
        const view = viewRef.current;
        if (!view) return;
        view.dispatch({ effects: flashRangeEffect.of(range) });
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => {
          viewRef.current?.dispatch({ effects: flashRangeEffect.of(null) });
          flashTimerRef.current = null;
        }, 1500);
      },
      writeContent: async (content) => {
        await window.fleet.file.write(filePath, content);
        const view = viewRef.current;
        if (view) {
          savedContentRef.current = content;
          view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
        }
      },
      save: async () => {
        await saveRef.current();
      }
    };
    registerEditorHandle(paneId, handle);
    return () => {
      unregisterEditorHandle(paneId);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [paneId, filePath]);

  // Rune IPC events are subscribed once at the app level (see useRuneAssistEvents) and
  // routed into the store by paneId — NOT here, because this pane unmounts on tab switch
  // and would otherwise miss the turn's result/idle event while it's in the background.

  // Cleanup dirty state on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      setPaneDirty(paneId, false);
    };
  }, [paneId, setPaneDirty]);

  if (loading) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#282c34] text-neutral-400 text-sm">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-[#282c34] text-red-400 text-sm">
        Error: {error}
      </div>
    );
  }

  if (tooLarge) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#282c34] text-neutral-400 text-sm gap-2">
        <div className="text-3xl text-neutral-500">⚠</div>
        <div className="font-medium text-neutral-200">File too large to edit</div>
        <div className="text-neutral-500">
          {(fileSize / 1024 / 1024).toFixed(1)} MB — limit is 10 MB
        </div>
      </div>
    );
  }

  const langLabel = getLanguageName(filePath);
  const saveStatus = isSaving
    ? { label: 'Saving...', className: 'text-neutral-500' }
    : isDirty
      ? { label: 'Modified', className: 'text-amber-400' }
      : { label: 'Saved', className: 'text-emerald-500' };

  return (
    <div className="relative h-full w-full flex flex-col overflow-hidden">
      {showPathChrome && <PathChromeHeader filePath={filePath} />}
      <div ref={containerRef} className="flex-1 min-h-0" />
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300 shrink-0">{langLabel}</span>
        <span className="text-neutral-500 shrink-0">
          Ln {cursorPos.line}, Col {cursorPos.col}
        </span>
        {showPathChrome && (
          <span className="text-neutral-500 font-mono truncate min-w-0 flex-1" title={filePath}>
            {filePath}
          </span>
        )}
        <span
          className={`flex items-center gap-1.5 shrink-0 ${showPathChrome ? '' : 'ml-auto'} ${saveStatus.className}`}
        >
          {saveStatus.label === 'Modified' && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
          )}
          {saveStatus.label}
        </span>
      </div>
      <RuneAssistLayer paneId={paneId} />
    </div>
  );
}
