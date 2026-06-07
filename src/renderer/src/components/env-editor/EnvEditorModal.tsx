import { useCallback, useEffect, useRef, useState } from 'react';
import {
  X,
  Folder,
  ChevronDown,
  Table,
  Code,
  Eye,
  EyeOff,
  Save,
  AlertTriangle,
  Loader2
} from 'lucide-react';
import { useToastStore } from '../../store/toast-store';
import { FileNavigator } from './FileNavigator';
import { EnvForm } from './EnvForm';
import { EnvRawEditor } from './EnvRawEditor';
import type { EnvFileEntry } from '../../../../shared/env-editor-types';
import {
  parseEnvFile,
  serializeEnvFile,
  type EnvLine,
  type ParsedEnvFile
} from '../../../../shared/env-parse';

const RAW_ONLY_BYTES = 256 * 1024;

export function EnvEditorModal({
  isOpen,
  onClose,
  cwd
}: {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
}): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const [root, setRoot] = useState<string | undefined>(cwd);
  const [files, setFiles] = useState<EnvFileEntry[]>([]);
  const [selected, setSelected] = useState<EnvFileEntry | null>(null);
  const [parsed, setParsed] = useState<ParsedEnvFile | null>(null);
  const [originalText, setOriginalText] = useState('');
  const mtimeMsRef = useRef(0);
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const [mode, setMode] = useState<'form' | 'raw'>('form');
  const [rawText, setRawText] = useState('');
  const showToast = useToastStore((s) => s.show);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externalChange, setExternalChange] = useState(false);

  useEffect(() => {
    if (isOpen) setRoot(cwd);
  }, [isOpen, cwd]);

  const reload = useCallback(async () => {
    if (!root) {
      setFiles([]);
      return;
    }
    const list = await window.fleet.envEditor.list(root);
    setFiles(list);
  }, [root]);

  useEffect(() => {
    if (isOpen) void reload();
  }, [isOpen, reload]);

  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    let cancelled = false;
    setRevealed(new Set());
    setRevealAll(false);
    setError(null);
    setExternalChange(false);
    if (!selected) {
      setParsed(null);
      setOriginalText('');
      setRawText('');
      setMode('form');
      return;
    }
    void window.fleet.envEditor.read(selected.absPath).then((res) => {
      if (cancelled) return;
      setOriginalText(res.text);
      mtimeMsRef.current = res.mtimeMs;
      setParsed(parseEnvFile(res.text));
      setRawText(res.text);
      setMode('form');
    });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const setLines = useCallback(
    (lines: EnvLine[]) => setParsed((p) => (p ? { ...p, lines } : p)),
    []
  );

  const toggleReveal = useCallback((index: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }, []);

  // Works in both modes: in raw mode onRawChange keeps `parsed` in sync, and
  // serializeEnvFile(parseEnvFile(x)) === x is a round-trip invariant of the parser.
  const dirty = parsed !== null && serializeEnvFile(parsed) !== originalText;

  const rawOnly = originalText.length > RAW_ONLY_BYTES;
  const effectiveMode = rawOnly ? 'raw' : mode;

  const onRawChange = useCallback((text: string) => {
    setRawText(text);
    setParsed(parseEnvFile(text));
  }, []);

  const showForm = useCallback(() => setMode('form'), []);
  const showRaw = useCallback(() => {
    if (parsed) setRawText(serializeEnvFile(parsed));
    setMode('raw');
  }, [parsed]);

  const pickFolder = useCallback(async () => {
    const dir = await window.fleet.showFolderPicker();
    if (dir !== null) {
      setSelected(null);
      setRoot(dir);
    }
  }, []);

  const save = useCallback(async () => {
    if (!selected || !parsed || saving) return;
    const text = serializeEnvFile(parsed);
    setSaving(true);
    setError(null);
    try {
      const res = await window.fleet.envEditor.write(selected.absPath, text, mtimeMsRef.current);
      if (!res.ok && res.externalChange) {
        setExternalChange(true);
        return;
      }
      setOriginalText(text);
      mtimeMsRef.current = res.mtimeMs;
      setExternalChange(false);
      void reload();
      showToast('Saved');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save file');
    } finally {
      setSaving(false);
    }
  }, [selected, parsed, saving, reload, showToast]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) void save();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, dirty, save]);

  const requestClose = useCallback(() => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    onClose();
  }, [dirty, onClose]);

  const selectFile = useCallback(
    (file: EnvFileEntry) => {
      if (dirty && !window.confirm('Discard unsaved changes to this file?')) return;
      setSelected(file);
    },
    [dirty]
  );

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={requestClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            requestClose();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className="flex h-[85vh] w-[860px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-5 py-3">
          <h2 className="text-base font-semibold text-neutral-100">Env Editor</h2>
          <button
            onClick={() => void pickFolder()}
            title={root}
            className="flex items-center gap-1.5 rounded-md bg-neutral-800 px-2.5 py-1 text-xs text-neutral-300 transition hover:bg-neutral-700 active:scale-[0.98]"
          >
            <Folder size={13} />
            <span className="max-w-[260px] truncate">
              {root ? basenameOf(root) : 'Pick folder'}
            </span>
            <ChevronDown size={13} className="text-neutral-500" />
          </button>
          <button
            onClick={() => void save()}
            disabled={!dirty || saving}
            title="Save (⌘S)"
            className="ml-auto inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white transition active:scale-[0.97] hover:bg-blue-500 disabled:bg-neutral-800 disabled:text-neutral-600 disabled:active:scale-100"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
          <button
            onClick={requestClose}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <FileNavigator
            files={files}
            selectedPath={selected?.absPath ?? null}
            dirtyPaths={dirty && selected ? new Set([selected.absPath]) : new Set()}
            onSelect={selectFile}
            onNewFile={() => undefined}
          />
          <div className="flex min-h-0 flex-1 flex-col">
            {error && (
              <div className="flex items-center gap-2 border-b border-red-800 bg-red-950/40 px-4 py-2 text-xs text-red-300">
                <AlertTriangle size={13} /> {error}
              </div>
            )}
            {externalChange && (
              <div className="flex items-center gap-2 border-b border-amber-800 bg-amber-950/40 px-4 py-2 text-xs text-amber-300">
                <AlertTriangle size={13} />
                This file changed on disk.
                <button
                  onClick={() => {
                    setExternalChange(false);
                    setSelected((s) => (s ? { ...s } : s));
                  }}
                  className="font-medium underline active:scale-95"
                >
                  Reload
                </button>
                <button
                  onClick={() => {
                    if (!selected || !parsed) return;
                    const text = serializeEnvFile(parsed);
                    setExternalChange(false);
                    void window.fleet.envEditor.write(selected.absPath, text).then((r) => {
                      mtimeMsRef.current = r.mtimeMs;
                      setOriginalText(text);
                      void reload();
                      showToast('Saved');
                    });
                  }}
                  className="font-medium underline active:scale-95"
                >
                  Overwrite
                </button>
              </div>
            )}
            {selected && (
              <div className="flex items-center gap-2 border-b border-neutral-800 px-4 py-2">
                <span className="font-mono text-xs text-neutral-200">{selected.name}</span>
                {selected.isTemplate && (
                  <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-neutral-500">
                    template
                  </span>
                )}
                {dirty && <span className="text-[10px] text-amber-400">● unsaved</span>}
                <div className="ml-auto flex items-center gap-2">
                  {effectiveMode !== 'raw' && (
                    <button
                      onClick={() => setRevealAll((v) => !v)}
                      className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-95"
                    >
                      {revealAll ? <EyeOff size={13} /> : <Eye size={13} />}
                      {revealAll ? 'Hide all' : 'Reveal all'}
                    </button>
                  )}
                  {!rawOnly && (
                    <div className="flex overflow-hidden rounded-md border border-neutral-700 text-xs">
                      <button
                        onClick={showForm}
                        className={`flex items-center gap-1 px-2.5 py-1 transition active:scale-95 ${
                          mode === 'form'
                            ? 'bg-blue-600 text-white'
                            : 'text-neutral-400 hover:bg-neutral-800'
                        }`}
                      >
                        <Table size={12} /> Form
                      </button>
                      <button
                        onClick={showRaw}
                        className={`flex items-center gap-1 px-2.5 py-1 transition active:scale-95 ${
                          mode === 'raw'
                            ? 'bg-blue-600 text-white'
                            : 'text-neutral-400 hover:bg-neutral-800'
                        }`}
                      >
                        <Code size={12} /> Raw
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
            {selected && parsed ? (
              effectiveMode === 'raw' ? (
                <EnvRawEditor text={rawText} onChange={onRawChange} />
              ) : (
                <EnvForm
                  lines={parsed.lines}
                  revealAll={revealAll}
                  revealed={revealed}
                  onToggleReveal={toggleReveal}
                  onResetReveal={() => setRevealed(new Set())}
                  onChange={setLines}
                />
              )
            ) : (
              <div className="flex flex-1 items-center justify-center p-6 text-sm text-neutral-500">
                {files.length === 0
                  ? 'No .env files in this folder yet.'
                  : 'Select a file to edit.'}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function basenameOf(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}
