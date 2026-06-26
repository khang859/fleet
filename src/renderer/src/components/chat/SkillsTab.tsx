import { useEffect, useState } from 'react';
import { FolderOpen, RefreshCw, ShieldAlert } from 'lucide-react';
import type {
  SkillState,
  SkillScope,
  SkillSummary,
  SkillsBudget
} from '../../../../shared/skill-types';
import { useChatStore } from '../../store/chat-store';

const NEXT_STATE: Record<SkillState, SkillState> = {
  on: 'name-only',
  'name-only': 'off',
  off: 'on'
};

const STATE_LABEL: Record<SkillState, string> = {
  on: 'On',
  'name-only': 'Name-only',
  off: 'Off'
};

const STATE_CLASS: Record<SkillState, string> = {
  on: 'bg-green-500/15 text-green-400',
  'name-only': 'bg-yellow-500/15 text-yellow-400',
  off: 'bg-fleet-surface-3 text-fleet-text-muted'
};

const SCOPE_ORDER: SkillScope[] = ['project', 'personal', 'bundled'];
const SCOPE_LABEL: Record<SkillScope, string> = {
  project: 'Project',
  personal: 'Personal',
  bundled: 'Bundled'
};

export function SkillsTab(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [budget, setBudget] = useState<SkillsBudget>({ used: 0, cap: 8000 });
  const loadSkillMenu = useChatStore((s) => s.loadSkillMenu);

  const refreshMenu = (): void => void loadSkillMenu();

  useEffect(() => {
    void window.fleet.chat.skillsGet().then((v) => {
      setSkills(v.skills);
      setBudget(v.budget);
    });
  }, []);

  const cycle = async (name: string, state: SkillState): Promise<void> => {
    const v = await window.fleet.chat.skillsSetState(name, NEXT_STATE[state]);
    setSkills(v.skills);
    setBudget(v.budget);
    refreshMenu();
  };

  const rescan = async (): Promise<void> => {
    const v = await window.fleet.chat.skillsRescan();
    setSkills(v.skills);
    setBudget(v.budget);
    refreshMenu();
  };

  const pct = budget.cap > 0 ? Math.min(100, Math.round((budget.used / budget.cap) * 100)) : 0;
  const over = budget.used > budget.cap;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fleet-text-muted">
          Skills add <em>know-how</em> (procedures). Names + descriptions are always loaded; the
          full instructions load on demand.
        </p>
        <div className="flex shrink-0 gap-1">
          <button
            type="button"
            onClick={() => void window.fleet.chat.skillsReveal()}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-fleet-text-muted hover:text-fleet-text"
          >
            <FolderOpen size={13} /> Folder
          </button>
          <button
            type="button"
            onClick={() => void rescan()}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-fleet-text-muted hover:text-fleet-text"
          >
            <RefreshCw size={13} /> Rescan
          </button>
        </div>
      </div>

      {/* Context-budget meter: tokens the always-on (On) descriptions consume. */}
      <div>
        <div className="mb-1 flex items-center justify-between text-[11px]">
          <span className="text-fleet-text-secondary">Always-on descriptions</span>
          <span className={over ? 'text-red-400' : 'text-fleet-text-muted'}>
            {budget.used.toLocaleString()} / {budget.cap.toLocaleString()} tokens
          </span>
        </div>
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-fleet-surface-3">
          <div
            className={`h-full ${over ? 'bg-red-400' : 'bg-fleet-accent'}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {skills.length === 0 && (
        <p className="text-xs text-fleet-text-muted">
          No skills found. Add a folder with a <code>SKILL.md</code> to your skills directory, then
          Rescan.
        </p>
      )}

      {SCOPE_ORDER.filter((scope) => skills.some((s) => s.scope === scope)).map((scope) => (
        <div key={scope}>
          <h4 className="mb-1 text-[11px] font-medium uppercase tracking-wide text-fleet-text-muted">
            {SCOPE_LABEL[scope]}
          </h4>
          <div className="space-y-2">
            {skills
              .filter((s) => s.scope === scope)
              .map((s) => (
                <div
                  key={s.name}
                  className="rounded border border-fleet-border bg-fleet-surface-2 p-2"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-mono text-sm text-fleet-text">
                      {s.name}
                    </span>
                    {!s.trusted && (
                      <span
                        title="From outside the app — review its files before enabling scripts."
                        className="flex items-center gap-0.5 text-[11px] text-yellow-400"
                      >
                        <ShieldAlert size={12} /> untrusted
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => void cycle(s.name, s.state)}
                      className={`rounded px-2 py-0.5 text-[11px] ${STATE_CLASS[s.state]}`}
                    >
                      {STATE_LABEL[s.state]}
                    </button>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[11px] text-fleet-text-muted">
                    {s.description}
                  </p>
                  {s.files.length > 0 && (
                    <p className="mt-1 truncate text-[11px] text-fleet-text-secondary">
                      files: {s.files.join(', ')}
                    </p>
                  )}
                </div>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
