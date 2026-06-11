import { useSettingsStore } from '../../../store/settings-store';
import { SettingRow } from '../SettingRow';
import { ProfileEditor } from './ProfileEditor';
import {
  DEFAULT_ORCHESTRATOR_INSTRUCTIONS,
  ORCHESTRATOR_PROFILE_NAME,
  type KanbanSettings,
  type WorkerProfile
} from '../../../../../shared/types';
import type { WorkspaceKind } from '../../../../../shared/kanban-types';
import {
  KANBAN_NOTIFY_CATEGORIES,
  type KanbanNotifyCategory
} from '../../../../../shared/kanban-notifications';

const KANBAN_NOTIFY_LABELS: Record<KanbanNotifyCategory, string> = {
  blocked: 'Blocked (needs you)',
  failed: 'Failed',
  completed: 'Completed',
  scheduleFired: 'Schedule fired'
};

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
        <SettingRow label="Auto-decompose triage tasks">
          <input
            type="checkbox"
            checked={k.dispatcher.autoDecompose}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, autoDecompose: e.target.checked } })
            }
            className="h-4 w-4"
          />
        </SettingRow>
        <SettingRow label="Auto-assign unassigned tasks">
          <input
            type="checkbox"
            checked={k.dispatcher.autoAssign}
            onChange={(e) =>
              patch({ dispatcher: { ...k.dispatcher, autoAssign: e.target.checked } })
            }
            className="h-4 w-4"
          />
        </SettingRow>
        <SettingRow label="Max concurrent orchestrator runs">
          <input
            type="number"
            min={1}
            value={k.dispatcher.maxDecompose}
            onChange={(e) =>
              patch({
                dispatcher: {
                  ...k.dispatcher,
                  maxDecompose: Math.max(1, Number(e.target.value) || 1)
                }
              })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
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
        <h3 className="text-sm font-semibold text-neutral-300">Artifacts</h3>
        <SettingRow label="Auto-remove discarded after (days, 0 = never)">
          <input
            type="number"
            min={0}
            value={k.artifactRetentionDays}
            onChange={(e) =>
              patch({ artifactRetentionDays: Math.max(0, Number(e.target.value) || 0) })
            }
            className="w-28 rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
          />
        </SettingRow>
        <p className="text-xs text-neutral-500">
          Discarded outputs stay recoverable for this window before they are permanently deleted to
          free disk. Kept artifacts are never auto-removed.
        </p>
      </section>

      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-neutral-300">Notifications</h3>
        <p className="text-xs text-neutral-500 mb-2">
          Surface worker and scheduler events as an OS notification and an unread badge on the
          Kanban tab.
        </p>
        <div className="grid grid-cols-3 gap-2 text-xs text-neutral-500 mb-1">
          <div>Event</div>
          <div className="text-center">Badge</div>
          <div className="text-center">OS</div>
        </div>
        {KANBAN_NOTIFY_CATEGORIES.map((cat) => (
          <div key={cat} className="grid grid-cols-3 gap-2 items-center">
            <div className="text-sm text-neutral-300">{KANBAN_NOTIFY_LABELS[cat]}</div>
            {(['badge', 'os'] as const).map((channel) => (
              <div key={channel} className="flex justify-center">
                <input
                  type="checkbox"
                  checked={k.notifications[cat][channel]}
                  onChange={(e) => {
                    patch({
                      notifications: {
                        ...k.notifications,
                        [cat]: {
                          ...k.notifications[cat],
                          [channel]: e.target.checked
                        }
                      }
                    });
                  }}
                  className="fleet-accent-input"
                />
              </div>
            ))}
          </div>
        ))}
      </section>

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-neutral-300">Worker profiles</h3>
          <button
            onClick={() =>
              patch({
                profiles: [
                  ...k.profiles,
                  { name: '', role: 'worker', model: '', skills: [], instructions: '' }
                ]
              })
            }
            className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 transition active:scale-[0.97]"
          >
            + New profile
          </button>
        </div>
        {!k.profiles.some((p) => p.role === 'worker') && (
          <p className="text-xs text-neutral-500">No profiles yet.</p>
        )}
        {k.profiles.map((p, i) => {
          if (p.role !== 'worker') return null;
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

      <OrchestratorSection k={k} patch={patch} />
    </div>
  );
}

/**
 * The orchestrator is a singleton — there is exactly one, it can't be deleted or assigned to a
 * task, so it gets its own panel (model + persona only) instead of a row in the worker list.
 */
function OrchestratorSection({
  k,
  patch
}: {
  k: KanbanSettings;
  patch: (next: Partial<KanbanSettings>) => void;
}): React.JSX.Element {
  const idx = k.profiles.findIndex((p) => p.role === 'orchestrator');
  const orchestrator: WorkerProfile =
    idx >= 0
      ? k.profiles[idx]
      : {
          name: ORCHESTRATOR_PROFILE_NAME,
          role: 'orchestrator',
          model: '',
          skills: [],
          instructions: DEFAULT_ORCHESTRATOR_INSTRUCTIONS
        };
  const update = (next: Partial<WorkerProfile>): void => {
    const merged = { ...orchestrator, ...next };
    patch({
      profiles:
        idx >= 0 ? k.profiles.map((q, j) => (j === idx ? merged : q)) : [...k.profiles, merged]
    });
  };
  const isDefault = orchestrator.instructions === DEFAULT_ORCHESTRATOR_INSTRUCTIONS;

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-neutral-300">Orchestrator</h3>
        <button
          onClick={() => update({ model: '', instructions: DEFAULT_ORCHESTRATOR_INSTRUCTIONS })}
          disabled={isDefault && orchestrator.model === ''}
          className="rounded border border-neutral-700 px-2 py-1 text-xs hover:bg-neutral-800 disabled:opacity-40 disabled:hover:bg-transparent transition active:scale-[0.97] disabled:active:scale-100"
        >
          Reset to default
        </button>
      </div>
      <p className="text-xs text-neutral-500">
        The single planner that decomposes tasks into child tasks. There is exactly one — it
        can&apos;t be deleted or assigned to a task.
      </p>
      <div className="rounded-md border border-neutral-800 bg-neutral-900/50 p-3 space-y-2">
        <input
          value={orchestrator.model}
          onChange={(e) => update({ model: e.target.value })}
          placeholder="model (optional, e.g. claude-opus-4-8)"
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
        />
        <textarea
          value={orchestrator.instructions}
          onChange={(e) => update({ instructions: e.target.value })}
          rows={10}
          placeholder="Orchestrator system prompt / persona…"
          className="w-full rounded bg-neutral-800 px-2 py-1 text-sm border border-neutral-700"
        />
      </div>
    </section>
  );
}
