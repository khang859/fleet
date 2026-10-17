import { useEffect, useMemo } from 'react';
import { DEFAULT_AGENCY_SETTINGS, type AgencySettings } from '../../../../shared/agency';
import { useSettingsStore } from '../../store/settings-store';
import { useAgentStore } from '../../store/agent-store';
import { ModelSelect } from '../agent/settings/ModelSelect';
import { BoundedNumber } from '../agent/settings/controls';
import { useAdmiralMarks } from '../../hooks/use-admiral-marks';
import { AdmiralChangeNote } from './AdmiralChangeNote';
import { AskAdmiralButton } from './AskAdmiral';
import { ClientFileEditor } from './ClientFileEditor';
import { SettingRow } from './SettingRow';

/** A dollar amount, stored when editing ends. See `BoundedNumber`. */
function DollarField(props: {
  id: string;
  label: string;
  value: number;
  max: number;
  fallback: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-sm text-fleet-text-muted">$</span>
      <BoundedNumber {...props} min={1} />
    </div>
  );
}

/**
 * Settings › Agency › Admiral: whether Admiral is on at all, the model it runs
 * on, what its jobs may spend, and each project's client file.
 */
export function AgencyAdmiralSection(): React.JSX.Element | null {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const catalog = useAgentStore((s) => s.catalog);
  const loadModels = useAgentStore((s) => s.loadModels);
  const marks = useAdmiralMarks(null);

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  // The Admiral calls tools on every turn, so only models that can are offered.
  const models = useMemo(() => (catalog?.models ?? []).filter((m) => m.supportsTools), [catalog]);

  if (!settings) return null;
  const agency = settings.agency;
  const patchAdmiral = (patch: Partial<AgencySettings['admiral']>): void => {
    void updateSettings({ agency: { admiral: patch } });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-fleet-text mb-1">Admiral</h2>
        <p className="text-sm text-fleet-text-muted">
          An Admiral runs one repository&apos;s work for you: you brief it, it plans the job, hires
          Claude Code crew in their own panes, and brings back the result.
        </p>
        {agency.enabled && (
          <div className="mt-3">
            <AskAdmiralButton page="Settings › Agency › Admiral" />
          </div>
        )}
      </div>

      <div>
        <SettingRow label="Enable Admiral">
          <input
            type="checkbox"
            checked={agency.enabled}
            onChange={(e) => void updateSettings({ agency: { enabled: e.target.checked } })}
            className="fleet-accent-input"
            aria-label="Enable Admiral"
          />
        </SettingRow>
        <p className="text-xs text-fleet-text-subtle mt-1">
          Adds the Open Admiral command and the compass next to New agent in the sidebar.
        </p>
      </div>

      <div className={agency.enabled ? 'space-y-6' : 'space-y-6 opacity-50 pointer-events-none'}>
        <div>
          <SettingRow label="Model" align="start">
            <div className="w-full">
              <ModelSelect
                models={models}
                value={agency.admiral.model === '' ? null : agency.admiral.model}
                onChange={(model) => patchAdmiral({ model: model ?? '' })}
                allowNone
                noneLabel="Use the Agent's coding model"
              />
            </div>
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            Runs on the key or local server set up in Agent settings. Never on your Claude Code
            login.
          </p>
        </div>

        <div>
          <SettingRow label="Default job budget">
            <DollarField
              id="agency-default-budget"
              label="Default job budget in dollars"
              value={agency.admiral.defaultBudgetUsd}
              max={10_000}
              fallback={DEFAULT_AGENCY_SETTINGS.admiral.defaultBudgetUsd}
              onCommit={(defaultBudgetUsd) => patchAdmiral({ defaultBudgetUsd })}
            />
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            What a job may spend unless you approve a plan with another budget.
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.defaultBudgetUsd" />
        </div>

        <div>
          <SettingRow label="Monthly cap">
            <DollarField
              id="agency-monthly-cap"
              label="Monthly cap in dollars"
              value={agency.admiral.monthlyCapUsd}
              max={100_000}
              fallback={DEFAULT_AGENCY_SETTINGS.admiral.monthlyCapUsd}
              onCommit={(monthlyCapUsd) => patchAdmiral({ monthlyCapUsd })}
            />
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            All jobs together in a calendar month. At the cap no new work starts.
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.monthlyCapUsd" />
        </div>

        <ClientFileEditor />
      </div>
    </div>
  );
}
