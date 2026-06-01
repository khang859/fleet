/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react';
import { useKanbanStore } from '../../store/kanban-store';
import { useSettingsStore } from '../../store/settings-store';
import type { SwarmWorkerSpec } from '../../../../shared/kanban-types';

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

export function SwarmModal({ onClose }: { onClose: () => void }): React.JSX.Element {
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
  const [error, setError] = useState<string | null>(null);

  async function submit(): Promise<void> {
    const workers = rowsToWorkerSpecs(rows);
    if (goal.trim() === '' || workers.length === 0 || !verifier || !synthesizer) {
      setError(
        'Goal, at least one complete worker row, a verifier, and a synthesizer are required.'
      );
      return;
    }
    const input = {
      goal: goal.trim(),
      workers,
      verifierAssignee: verifier,
      synthesizerAssignee: synthesizer
    };
    try {
      if (seed?.target === 'swarm') {
        await createSwarmFromArtifact(seed.artifact.id, { ...input, boardId: activeBoardSlug });
      } else {
        await createSwarm(input);
      }
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-h-[80vh] overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900 p-4"
        onClick={(e) => e.stopPropagation()}
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
              className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
              disabled={rows.length === 1}
            >
              ×
            </button>
          </div>
        ))}
        <button
          onClick={() => setRows([...rows, { profile: firstWorker, title: '', skills: '' }])}
          className="mb-3 rounded px-2 py-1 text-xs text-blue-400 hover:bg-neutral-800"
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
        {error && <div className="mb-2 text-xs text-red-400">{error}</div>}
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded px-3 py-1 text-xs text-neutral-400 hover:bg-neutral-800"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
          >
            Create Swarm
          </button>
        </div>
      </div>
    </div>
  );
}
