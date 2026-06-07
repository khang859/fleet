/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState } from 'react';
import { useKanbanStore } from '../../store/kanban-store';
import { useSettingsStore } from '../../store/settings-store';
import type { SwarmWorkerSpec } from '../../../../shared/kanban-types';
import { Overlay } from '../Overlay';

export interface WorkerRow {
  profile: string;
  title: string;
  skills: string;
}

/** Pure: turn modal rows into worker specs, dropping incomplete rows. */
export function rowsToWorkerSpecs(rows: WorkerRow[]): SwarmWorkerSpec[] {
  return rows
    .filter((r) => r.profile.trim() !== '' && r.title.trim() !== '')
    .map((r) => ({
      profile: r.profile.trim(),
      title: r.title.trim(),
      skills: r.skills
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }));
}

export function SwarmModal({
  open,
  onClose
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const createSwarm = useKanbanStore((s) => s.createSwarm);
  const createSwarmFromArtifact = useKanbanStore((s) => s.createSwarmFromArtifact);
  const seed = useKanbanStore((s) => s.seed);
  const activeBoardSlug = useKanbanStore((s) => s.activeBoardSlug);
  const profiles = useSettingsStore((s) => s.settings?.kanban.profiles ?? []);
  const workerProfiles = profiles.filter((p) => p.role === 'worker');
  const firstWorker = workerProfiles[0]?.name ?? '';

  const [goal, setGoal] = useState('');
  const [rows, setRows] = useState<WorkerRow[]>([{ profile: firstWorker, title: '', skills: '' }]);
  const [verifier, setVerifier] = useState(firstWorker);
  const [synthesizer, setSynthesizer] = useState(firstWorker);
  const [mode, setMode] = useState<'scratch' | 'project'>('scratch');
  const [folder, setFolder] = useState('');
  const [isolated, setIsolated] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Re-seed the form each time the modal opens (it now stays mounted so its exit
  // animation can play, so state must be reset on open rather than on mount).
  const prevOpen = useRef(false);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setGoal('');
      setRows([{ profile: firstWorker, title: '', skills: '' }]);
      setVerifier(firstWorker);
      setSynthesizer(firstWorker);
      setMode('scratch');
      setFolder('');
      setIsolated(true);
      setError(null);
    }
    prevOpen.current = open;
  }, [open, firstWorker]);

  async function pickFolder(): Promise<void> {
    const path = await window.fleet.showFolderPicker();
    if (path) setFolder(path);
  }

  async function submit(): Promise<void> {
    const workers = rowsToWorkerSpecs(rows);
    if (goal.trim() === '' || workers.length === 0 || !verifier || !synthesizer) {
      setError(
        'Goal, at least one complete worker row, a verifier, and a synthesizer are required.'
      );
      return;
    }
    const dir = folder.trim();
    if (mode === 'project' && !dir) {
      setError('Select a project folder, or choose the empty sandbox.');
      return;
    }
    // Every node in the swarm shares this workspace. Worktree gives each its own
    // isolated copy; a plain folder is shared directly (the user opted out of isolation).
    const workspace =
      mode === 'scratch'
        ? { workspaceKind: 'scratch' as const }
        : isolated
          ? { workspaceKind: 'worktree' as const, repoPath: dir }
          : { workspaceKind: 'dir' as const, workspacePath: dir };
    const input = {
      goal: goal.trim(),
      workers,
      verifierAssignee: verifier,
      synthesizerAssignee: synthesizer,
      ...workspace
    };
    try {
      if (seed?.target === 'swarm') {
        await createSwarmFromArtifact(seed.artifact.id, { ...input, boardId: activeBoardSlug });
      } else {
        await createSwarm({ ...input, boardId: activeBoardSlug });
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-[560px] max-h-[80vh] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-4"
    >
      <h2 className="mb-3 text-sm font-semibold text-neutral-100">New Swarm</h2>
      {seed?.target === 'swarm' && (
        <div className="mb-3 flex items-center gap-1 rounded bg-purple-950/40 px-2 py-1 text-[11px] text-purple-300">
          📦 Seeding root task with <span className="font-medium">{seed.artifact.filename}</span>
        </div>
      )}
      <textarea
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        placeholder="Swarm goal / final outcome…"
        className="mb-3 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
        rows={2}
      />
      <div className="mb-2 text-xs font-medium text-neutral-300">Workers</div>
      {rows.map((row, i) => (
        <div key={i} className="mb-2 flex items-center gap-2">
          <select
            value={row.profile}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, profile: e.target.value } : r)))
            }
            className="rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
          >
            {workerProfiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            value={row.title}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, title: e.target.value } : r)))
            }
            placeholder="Task title…"
            className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          />
          <input
            value={row.skills}
            onChange={(e) =>
              setRows(rows.map((r, j) => (j === i ? { ...r, skills: e.target.value } : r)))
            }
            placeholder="skills (comma)"
            className="w-28 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
          />
          <button
            onClick={() => setRows(rows.filter((_, j) => j !== i))}
            className="rounded px-2 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 active:scale-90 disabled:active:scale-100"
            disabled={rows.length === 1}
          >
            ×
          </button>
        </div>
      ))}
      <button
        onClick={() => setRows([...rows, { profile: firstWorker, title: '', skills: '' }])}
        className="mb-3 rounded px-2 py-1 text-xs text-blue-400 transition hover:bg-neutral-800 active:scale-[0.97]"
      >
        + Add worker
      </button>
      <div className="mb-3 flex gap-3">
        <label className="flex-1 text-xs text-neutral-300">
          Verifier
          <select
            value={verifier}
            onChange={(e) => setVerifier(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
          >
            {workerProfiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex-1 text-xs text-neutral-300">
          Synthesizer
          <select
            value={synthesizer}
            onChange={(e) => setSynthesizer(e.target.value)}
            className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs"
          >
            {workerProfiles.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mb-1 text-[11px] font-medium text-neutral-400">
        Where should the swarm work?
      </div>
      <label className="mb-1 flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="radio"
          name="swarm-ws-mode"
          checked={mode === 'scratch'}
          onChange={() => setMode('scratch')}
        />
        Empty sandbox{' '}
        <span className="text-neutral-500">(no project — a fresh, empty folder per task)</span>
      </label>
      <label className="mb-1 flex items-center gap-2 text-xs text-neutral-300">
        <input
          type="radio"
          name="swarm-ws-mode"
          checked={mode === 'project'}
          onChange={() => setMode('project')}
        />
        A project folder
      </label>
      {mode === 'project' && (
        <div className="mb-2 flex flex-col gap-2 pl-6">
          <div className="flex items-center gap-2">
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              placeholder="No folder selected…"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
            />
            <button
              onClick={() => void pickFolder()}
              className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-[0.97]"
            >
              Browse…
            </button>
          </div>
          <label className="flex items-start gap-2 text-xs text-neutral-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={isolated}
              onChange={(e) => setIsolated(e.target.checked)}
            />
            <span>
              Work on an isolated copy{' '}
              <span className="text-neutral-500">
                (git worktree — each task gets its own copy; leaves your files untouched. Requires a
                git repo. Unchecked: every task shares the folder directly.)
              </span>
            </span>
          </label>
        </div>
      )}
      {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="rounded px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 active:scale-[0.97]"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          className="rounded bg-blue-600 px-3 py-1 text-xs text-white transition hover:bg-blue-500 active:scale-[0.97]"
        >
          Create Swarm
        </button>
      </div>
    </Overlay>
  );
}
