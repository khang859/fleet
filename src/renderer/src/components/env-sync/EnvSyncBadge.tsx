// src/renderer/src/components/env-sync/EnvSyncBadge.tsx
import { useEffect, useState } from 'react';
import type { TargetStatus, TargetSyncState } from '../../../../shared/env-sync-types';

// 'error' ranks highest so an auth/config failure is never masked by a benign state.
const SYNC_STATE_ORDER: TargetSyncState[] = [
  'error',
  'conflict',
  'remote-ahead',
  'local-ahead',
  'remote-only',
  'local-only',
  'in-sync',
  'no-remote-no-local'
];

async function fetchAggState(cwd: string): Promise<TargetSyncState | null> {
  const repo = await window.fleet.envSync.discover(cwd);
  if (!repo) return null;
  const statuses = await window.fleet.envSync.status(repo.repoDir);
  return SYNC_STATE_ORDER.find((s) => statuses.some((t: TargetStatus) => t.state === s)) ?? null;
}

/** Aggregate badge for the active tab's resolved repo. Pass the active tab cwd. */
export function EnvSyncBadge({ cwd }: { cwd: string | undefined }): React.JSX.Element | null {
  const [agg, setAgg] = useState<TargetSyncState | null>(null);

  useEffect(() => {
    if (!cwd) {
      setAgg(null);
      return;
    }
    let active = true;
    const load = (): void => {
      fetchAggState(cwd)
        .then((state) => {
          if (active) setAgg(state);
        })
        .catch(() => {
          if (active) setAgg('error');
        });
    };
    load();
    // Re-aggregate whenever the modal (or any flow) mutates env-sync state, so the
    // badge reflects fixes immediately instead of going stale until a refresh.
    window.addEventListener('env-sync:changed', load);
    return () => {
      active = false;
      window.removeEventListener('env-sync:changed', load);
    };
  }, [cwd]);

  if (!agg || agg === 'no-remote-no-local') return null;

  const color =
    agg === 'conflict' || agg === 'error'
      ? 'bg-red-600'
      : agg === 'in-sync'
        ? 'bg-green-600'
        : 'bg-amber-600';

  const glyph = agg === 'in-sync' ? '✓' : agg === 'conflict' ? '!' : agg === 'error' ? '⚠' : '↑↓';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-white ${color}`}
      title={`Env Sync: ${agg}`}
    >
      env {glyph}
    </span>
  );
}
