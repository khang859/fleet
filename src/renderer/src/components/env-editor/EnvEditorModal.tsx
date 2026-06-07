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
import { NewFileDialog } from './NewFileDialog';
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
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFileError, setNewFileError] = useState<string | null>(null);

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
    if (isOpen) {
      setError(null);
      setExternalChange(false);
      void reload();
    }
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

  const writeFile = useCallback(
    async (force: boolean) => {
      if (!selected || !parsed || saving) return;
      const text = serializeEnvFile(parsed);
      setSaving(true);
      setError(null);
      try {
        const res = await window.fleet.envEditor.write(
          selected.absPath,
          text,
          force ? undefined : mtimeMsRef.current
        );
        if (!res.ok && res.externalChange) {
          setExternalChange(true);
          return;
        }
        setOriginalText(text);
        mtimeMsRef.current = res.mtimeMs;
        setExternalChange(false);
        void reload(); // refresh var counts
        showToast('Saved');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to save file');
      } finally {
        setSaving(false);
      }
    },
    [selected, parsed, saving, reload, showToast]
  );

  const save = useCallback(() => {
    void writeFile(false);
  }, [writeFile]);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (dirty) save();
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

  const dialogGroups = (() => {
    const gs = Array.from(new Set(files.map((f) => f.group)));
    return gs.length ? gs : ['·root'];
  })();

  const createFile = useCallback(
    async (group: string, name: string) => {
      if (!root) return;
      setNewFileError(null);
      try {
        const dir = group === '·root' ? root : `${root}/${group}`;
        const { absPath } = await window.fleet.envEditor.create(dir, name);
        const list = await window.fleet.envEditor.list(root);
        setFiles(list);
        setNewFileOpen(false);
        const created = list.find((f) => f.absPath === absPath) ?? null;
        if (created) setSelected(created);
      } catch (e) {
        setNewFileError(e instanceof Error ? e.message : 'Could not create file');
      }
    },
    [root]
  );

  const renameFile = useCallback(
    async (file: EnvFileEntry, newName: string) => {
      if (!root || newName === file.name) return;
      if (!newName.startsWith('.env')) {
        showToast('File name must start with ".env"');
        return;
      }
      try {
        const { absPath } = await window.fleet.envEditor.rename(file.absPath, newName);
        const list = await window.fleet.envEditor.list(root);
        setFiles(list);
        if (selected?.absPath === file.absPath) {
          setSelected(list.find((f) => f.absPath === absPath) ?? null);
        }
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Could not rename file');
      }
    },
    [root, selected, showToast]
  );

  const deleteFile = useCallback(
    async (file: EnvFileEntry) => {
      try {
        const { trashPath } = await window.fleet.envEditor.delete(file.absPath);
        if (selected?.absPath === file.absPath) setSelected(null);
        await reload();
        showToast(`Deleted ${file.relPath}`, {
          action: {
            label: 'Undo',
            onClick: () => {
              void window.fleet.envEditor.restore(trashPath, file.absPath).then(() => {
                void reload();
              });
            }
          }
        });
      } catch (e) {
        showToast(e instanceof Error ? e.message : 'Could not delete file');
      }
    },
    [reload, selected, showToast]
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
            onClick={() => save()}
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
            onNewFile={() => {
              setNewFileError(null);
              setNewFileOpen(true);
            }}
            onRename={(file, newName) => void renameFile(file, newName)}
            onDelete={(file) => void deleteFile(file)}
          />
          <div className="relative flex min-h-0 flex-1 flex-col">
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
                    // Shallow-clone selected to force the [selected] loader effect to re-read from disk.
                    setSelected((s) => (s ? { ...s } : s));
                  }}
                  className="font-medium underline active:scale-95"
                >
                  Reload
                </button>
                <button
                  onClick={() => {
                    void writeFile(true);
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
            {newFileOpen && (
              <NewFileDialog
                groups={dialogGroups}
                error={newFileError}
                onCancel={() => setNewFileOpen(false)}
                onCreate={(group, name) => void createFile(group, name)}
              />
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
