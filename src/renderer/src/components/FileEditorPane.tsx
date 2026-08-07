import { useEffect, useRef, useState, useCallback } from 'react';
import { EditorState, StateEffect } from '@codemirror/state';
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
import { syntaxHighlighting, defaultHighlightStyle, LanguageSupport } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { oneDark } from '@codemirror/theme-one-dark';
import { getLanguageForPath } from '../../../shared/languages';
import { useWorkspaceStore } from '../store/workspace-store';
import { registerFileSave, unregisterFileSave } from '../lib/file-save-registry';
import { useDelayedFlag } from '../hooks/use-delayed-flag';
import { Skeleton } from './Skeleton';
import { PathChromeHeader } from './PathChromeHeader';
import { useToastStore } from '../store/toast-store';
import type { PathContext } from '../../../shared/shell-profiles';
import type { RemoteFileRef } from '../../../shared/remote-ssh-types';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const AUTO_SAVE_DELAY = 3000; // 3 seconds

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

/**
 * Save back over SSH. Refuses (rather than clobbers) when the remote file has
 * moved on since it was fetched - the user is told and the buffer stays dirty,
 * so nothing is lost on either side.
 */
async function writeRemote(
  remote: RemoteFileRef,
  content: string,
  mtimeRef: React.MutableRefObject<number | undefined>,
  showToast: (message: string) => void
): Promise<{ success: boolean }> {
  const result = await window.fleet.remoteSsh.writeText(
    remote.host,
    remote.path,
    content,
    mtimeRef.current
  );
  if (!result.success) {
    showToast(`Save failed: ${result.error}`);
    return { success: false };
  }
  if (!result.data.ok) {
    showToast('Not saved - the file changed on the server since it was opened');
    return { success: false };
  }
  mtimeRef.current = result.data.mtimeMs;
  return { success: true };
}

type Props = {
  paneId: string;
  filePath: string;
  pathContext?: PathContext;
  onContentChange?: (content: string) => void;
  /** When false, hides the built-in path header + footer path — used when the host pane renders its own chrome. */
  showPathChrome?: boolean;
  /**
   * Set when `filePath` is a local cache copy of a remote file. Reads still come
   * from the cache (it is byte-identical and already fetched), but saves go back
   * over SSH, guarded by the remote mtime observed at fetch time.
   */
  remote?: RemoteFileRef;
};

export function FileEditorPane({
  paneId,
  filePath,
  pathContext,
  onContentChange,
  showPathChrome = true,
  remote
}: Props): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const showLoadingSkeleton = useDelayedFlag(loading);
  const [error, setError] = useState<string | null>(null);
  const [tooLarge, setTooLarge] = useState(false);
  const [fileSize, setFileSize] = useState(0);
  const [isDirty, setIsDirty] = useState(false);
  const [cursorPos, setCursorPos] = useState({ line: 1, col: 1 });
  const [isSaving, setIsSaving] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const savedContentRef = useRef<string>('');
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialContentRef = useRef<string | null>(null);
  const setPaneDirty = useWorkspaceStore((s) => s.setPaneDirty);

  // Advances on every successful remote save so consecutive saves keep passing
  // the concurrency check instead of tripping on their own previous write.
  const remoteMtimeRef = useRef(remote?.mtimeMs);
  remoteMtimeRef.current ??= remote?.mtimeMs;
  const showToast = useToastStore((s) => s.show);

  const save = useCallback(async () => {
    if (!viewRef.current) return;
    setIsSaving(true);
    const content = viewRef.current.state.doc.toString();
    const result = remote
      ? await writeRemote(remote, content, remoteMtimeRef, showToast)
      : await window.fleet.file.write(filePath, content, pathContext);
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
  }, [filePath, pathContext, paneId, setPaneDirty, remote, showToast]);

  // Keep saveRef current so closures in EditorView always call the latest save
  const saveRef = useRef(save);
  saveRef.current = save;

  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;

  // Load file on mount
  useEffect(() => {
    void window.fleet.file.read(filePath, pathContext).then((result) => {
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
  }, [filePath, pathContext]);

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
            onContentChangeRef.current?.(current);
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

  // Cleanup dirty state on unmount
  useEffect(() => {
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
      setPaneDirty(paneId, false);
    };
  }, [paneId, setPaneDirty]);

  if (loading) {
    return (
      <div className="h-full w-full bg-[#282c34]">
        <span className="sr-only" role="status" aria-live="polite">
          Loading file…
        </span>
        {showLoadingSkeleton && (
          <div className="h-full w-full flex flex-col gap-2 p-4">
            {['w-2/3', 'w-1/2', 'w-5/6', 'w-1/3', 'w-3/4', 'w-1/2', 'w-2/5'].map((w, i) => (
              <Skeleton key={i} className={`h-3.5 ${w}`} />
            ))}
          </div>
        )}
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

  // Users think in terms of the remote path, not the cache copy backing it.
  const displayPath = remote ? `${remote.host.label}:${remote.path}` : filePath;
  const langLabel = getLanguageName(filePath);
  const saveStatus = isSaving
    ? { label: 'Saving...', className: 'text-neutral-500' }
    : isDirty
      ? { label: 'Modified', className: 'text-amber-400' }
      : { label: 'Saved', className: 'text-emerald-500' };

  return (
    <div ref={wrapperRef} className="relative h-full w-full flex flex-col overflow-hidden">
      {showPathChrome && <PathChromeHeader filePath={displayPath} />}
      <div ref={containerRef} className="flex-1 min-h-0" />
      <div className="flex-shrink-0 flex items-center gap-3 px-3 h-7 bg-neutral-950/80 border-t border-neutral-800 text-xs text-neutral-400">
        <span className="text-neutral-300 shrink-0">{langLabel}</span>
        <span className="text-neutral-500 shrink-0">
          Ln {cursorPos.line}, Col {cursorPos.col}
        </span>
        {showPathChrome && (
          <span className="text-neutral-500 font-mono truncate min-w-0 flex-1" title={displayPath}>
            {displayPath}
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
    </div>
  );
}
