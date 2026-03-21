import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLineGutter,
  highlightSpecialChars,
  drawSelection,
  highlightActiveLine
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import type { LanguageSupport } from '@codemirror/language';
import { useWorkspaceStore } from '../store/workspace-store';
import { registerFileSave, unregisterFileSave } from '../lib/file-save-registry';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const AUTO_SAVE_DELAY = 3000; // 3 seconds

function getLanguageExtension(filePath: string): LanguageSupport | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return javascript();
    case 'ts':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'jsx':
      return javascript({ jsx: true });
    case 'html':
    case 'htm':
      return html();
    case 'css':
    case 'scss':
    case 'less':
      return css();
    case 'json':
      return json();
    case 'md':
    case 'markdown':
      return markdown();
    case 'py':
      return python();
    default:
      return null;
  }
}

function getLanguageName(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'JavaScript';
    case 'ts':
      return 'TypeScript';
    case 'tsx':
      return 'TSX';
    case 'jsx':
      return 'JSX';
    case 'html':
    case 'htm':
      return 'HTML';
    case 'css':
      return 'CSS';
    case 'scss':
      return 'SCSS';
    case 'less':
      return 'Less';
    case 'json':
      return 'JSON';
    case 'md':
    case 'markdown':
      return 'Markdown';
    case 'py':
      return 'Python';
    default:
      return 'Plain Text';
  }
}

type Props = {
  paneId: string;
  filePath: string;
};

export function FileEditorPane({ paneId, filePath }: Props): React.JSX.Element {
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

  const setPaneDirty = useWorkspaceStore((s) => s.setPaneDirty);

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

    const langExt = getLanguageExtension(filePath);

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
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void saveRef.current();
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
            setPaneDirty(paneId, dirty);
            if (dirty) {
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
            '.cm-scroller': { overflow: 'auto' }
          }),
          ...(langExt ? [langExt] : [])
        ]
      }),
      parent: containerRef.current
    });

    viewRef.current = view;

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
    <div className="h-full w-full flex flex-col overflow-hidden">
      <div ref={containerRef} className="flex-1 min-h-0" />
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300">{langLabel}</span>
        <span className="text-neutral-500">
          Ln {cursorPos.line}, Col {cursorPos.col}
        </span>
        <span className={`ml-auto flex items-center gap-1.5 ${saveStatus.className}`}>
          {saveStatus.label === 'Modified' && (
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400" />
          )}
          {saveStatus.label}
        </span>
      </div>
    </div>
  );
}
