import { useSettingsStore } from '../../../store/settings-store';
import { SettingRow } from '../SettingRow';
import { ProfileEditor } from './ProfileEditor';
import type { KanbanSettings, WorkerProfile } from '../../../../../shared/types';
import type { WorkspaceKind } from '../../../../../shared/kanban-types';

const WORKSPACE_KINDS: WorkspaceKind[] = ['scratch', 'dir', 'worktree'];

export function KanbanSection(): React.JSX.Element | null {
  const { settings, updateSettings } = useSettingsStore();
  if (!settings) return null;
  const k = settings.kanban;

  const patch = (next: Partial<KanbanSettings>): void => {
    void updateSettings({ kanban: { ...k, ...next } });
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-300">Dispatcher</h3>
        <SettingRow label="Tick interval (ms)">
          <input
            type="number"
            min={1000}
            value={k.dispatcher.intervalMs}
            onChange={(e) =>
              patch({
                dispatcher: {
                  ...k.dispatcher,
                  intervalMs: Math.max(1000, Number(e.target.value) || 5000)
                }
              })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <SettingRow label="Max concurrent workers">
          <input
            type="number"
            min={1}
            value={k.dispatcher.maxInProgress}
            onChange={(e) =>
              patch({
                dispatcher: {
                  ...k.dispatcher,
                  maxInProgress: Math.max(1, Number(e.target.value) || 1)
                }
              })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <SettingRow label="Failure limit (before give-up)">
          <input
            type="number"
            min={1}
            value={k.dispatcher.failureLimit}
            onChange={(e) =>
              patch({
                dispatcher: {
                  ...k.dispatcher,
                  failureLimit: Math.max(1, Number(e.target.value) || 1)
                }
              })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <SettingRow label="Claim TTL (ms)">
          <input
            type="number"
            min={60000}
            value={k.dispatcher.claimTtlMs}
            onChange={(e) =>
              patch({
                dispatcher: {
                  ...k.dispatcher,
                  claimTtlMs: Math.max(60000, Number(e.target.value) || 900000)
                }
              })
            }
            className="w-32 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-300">New-task defaults</h3>
        <SettingRow label="Workspace kind">
          <select
            value={k.defaults.workspaceKind}
            onChange={(e) => {
              const workspaceKind =
                WORKSPACE_KINDS.find((w) => w === e.target.value) ?? k.defaults.workspaceKind;
              patch({ defaults: { ...k.defaults, workspaceKind } });
            }}
            className="rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          >
            {WORKSPACE_KINDS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow label="Max runtime (seconds, blank = none)">
          <input
            type="number"
            min={0}
            value={k.defaults.maxRuntimeSeconds ?? ''}
            onChange={(e) =>
              patch({
                defaults: {
                  ...k.defaults,
                  maxRuntimeSeconds: e.target.value === '' ? null : Number(e.target.value)
                }
              })
            }
            className="w-32 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-300">Worker profiles</h3>
          <button
            onClick={() =>
              patch({
                profiles: [...k.profiles, { name: '', model: '', skills: [], instructions: '' }]
              })
            }
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800"
          >
            + New profile
          </button>
        </div>
        {k.profiles.length === 0 && <p className="text-xs text-neutral-500">No profiles yet.</p>}
        {k.profiles.map((p, i) => {
          const duplicate =
            p.name !== '' && k.profiles.some((q, j) => j !== i && q.name === p.name);
          return (
            <ProfileEditor
              key={p.name || i}
              profile={p}
              duplicate={duplicate}
              onChange={(next: WorkerProfile) =>
                patch({ profiles: k.profiles.map((q, j) => (j === i ? next : q)) })
              }
              onDelete={() => patch({ profiles: k.profiles.filter((_, j) => j !== i) })}
            />
          );
        })}
      </section>
    </div>
  );
}
