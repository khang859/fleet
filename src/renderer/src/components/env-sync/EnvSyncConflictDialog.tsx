// src/renderer/src/components/env-sync/EnvSyncConflictDialog.tsx
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useToastStore } from '../../store/toast-store';
import type { EnvDiff } from '../../../../shared/env-sync-types';

const ConflictTargetSchema = z.object({ repoDir: z.string().min(1), envFile: z.string().min(1) });
type ConflictTarget = z.infer<typeof ConflictTargetSchema>;

export function EnvSyncConflictDialog(): React.JSX.Element | null {
  const showToast = useToastStore((s) => s.show);
  const [target, setTarget] = useState<ConflictTarget | null>(null);
  const [diff, setDiff] = useState<EnvDiff | null>(null);

  useEffect(() => {
    const onConflict = (e: Event): void => {
      if (!(e instanceof CustomEvent)) return;
      const parsed = ConflictTargetSchema.safeParse(e.detail);
      if (!parsed.success) return;
      setTarget(parsed.data);
      void window.fleet.envSync.diff(parsed.data.repoDir, parsed.data.envFile).then((res) => {
        if (!res.ok && 'diff' in res) setDiff(res.diff);
      });
    };
    window.addEventListener('env-sync:conflict', onConflict);
    return () => window.removeEventListener('env-sync:conflict', onConflict);
  }, []);

  if (!target) return null;

  const resolve = async (choice: 'keep-local' | 'keep-remote'): Promise<void> => {
    const res = await window.fleet.envSync.resolve(target.repoDir, target.envFile, choice);
    showToast(res.ok ? `Resolved ${target.envFile} (${choice})` : 'Resolve failed', {
      duration: 5000
    });
    setTarget(null);
    setDiff(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-[560px] max-h-[80vh] overflow-auto rounded-lg border border-neutral-700 bg-neutral-900 p-4">
        <h3 className="text-sm font-semibold text-neutral-200">Sync conflict: {target.envFile}</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Both local and remote changed. Pick which to keep.
        </p>
        <table className="mt-3 w-full text-xs">
          <thead>
            <tr className="text-neutral-500">
              <th className="text-left">Key</th>
              <th className="text-left">Change</th>
              <th className="text-left">Local</th>
              <th className="text-left">Remote</th>
            </tr>
          </thead>
          <tbody>
            {(diff?.entries ?? [])
              .filter((e) => e.change !== 'unchanged')
              .map((e) => (
                <tr key={e.key} className="border-t border-neutral-800">
                  <td className="py-1 text-neutral-300">{e.key}</td>
                  <td className="py-1 text-neutral-500">{e.change}</td>
                  <td className="py-1 text-neutral-400">{e.localMask ?? '—'}</td>
                  <td className="py-1 text-neutral-400">{e.remoteMask ?? '—'}</td>
                </tr>
              ))}
          </tbody>
        </table>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="text-xs px-3 py-1 rounded bg-neutral-800"
            onClick={() => {
              setTarget(null);
              setDiff(null);
            }}
          >
            Cancel
          </button>
          <button
            className="text-xs px-3 py-1 rounded bg-neutral-700"
            onClick={() => void resolve('keep-remote')}
          >
            Keep Remote
          </button>
          <button
            className="text-xs px-3 py-1 rounded bg-blue-700"
            onClick={() => void resolve('keep-local')}
          >
            Keep Local
          </button>
        </div>
      </div>
    </div>
  );
}
