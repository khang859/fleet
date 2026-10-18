import { useEffect, useMemo } from 'react';
import { DEFAULT_AGENCY_SETTINGS, type AgencySettings } from '../../../../shared/agency';
import {
  NUDGE_LIMIT_MAX,
  PERMISSION_EXPIRY_MAX_SEC,
  PERMISSION_EXPIRY_MIN_SEC
} from '../../../../shared/agency-settings';
import { clockTime } from '../../../../shared/agency-crew';
import { nextMonthStart } from '../../../../shared/agency-spend';
import { useSettingsStore } from '../../store/settings-store';
import { useAgentStore } from '../../store/agent-store';
import { ModelSelect } from '../agent/settings/ModelSelect';
import { BoundedNumber } from '../agent/settings/controls';
import { useAdmiralMarks } from '../../hooks/use-admiral-marks';
import { BudgetPicker } from '../admiral/BudgetPicker';
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

/** A percentage of a Claude Code usage window, stored when editing ends. */
function PercentField({
  prefix,
  ...props
}: {
  id: string;
  label: string;
  prefix: string;
  value: number;
  fallback: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  return (
    <label htmlFor={props.id} className="flex items-center gap-1.5">
      {prefix}
      <BoundedNumber {...props} min={1} max={100} className="w-16" />%
    </label>
  );
}

/** `Nov 1, 00:00`. */
const resetText = (at: number): string =>
  `${new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${clockTime(at)}`;

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
          <SettingRow label="Default job budget" align="start">
            <BudgetPicker
              meter="usd"
              value={agency.admiral.defaultBudgetUsd}
              monthlyCapUsd={agency.admiral.monthlyCapUsd}
              label="Default job budget in dollars"
              onChange={(n) => n !== null && patchAdmiral({ defaultBudgetUsd: n })}
            />
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            Real dollars a job may spend unless you approve a plan with another budget: the
            Admiral&apos;s model, eva, and Claude Code paid through an API key.
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.defaultBudgetUsd" />
        </div>

        <div>
          <SettingRow label="Default Claude share" align="start">
            <BudgetPicker
              meter="week_pct"
              value={agency.admiral.defaultBudgetWeekPct}
              label="Default share of the weekly Claude limit, in percent"
              onChange={(n) => n !== null && patchAdmiral({ defaultBudgetWeekPct: n })}
            />
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            How much of your weekly Claude Code limit a job&apos;s Claude crew may use. Claude Code
            reports one share for the whole account, so a job&apos;s share is an estimate.
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.defaultBudgetWeekPct" />
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
            All jobs together in a calendar month. At the cap no new work starts. It starts over at
            00:00 on the 1st, local time (next: {resetText(nextMonthStart(Date.now()))}).
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.monthlyCapUsd" />
        </div>

        <div>
          <SettingRow label="Keep in reserve">
            <div className="flex items-center gap-3 text-sm text-fleet-text-muted">
              <PercentField
                id="agency-reserve-5h"
                label="5-hour window reserve in percent"
                prefix="5-hour"
                value={agency.admiral.reserveFiveHourPct}
                fallback={DEFAULT_AGENCY_SETTINGS.admiral.reserveFiveHourPct}
                onCommit={(reserveFiveHourPct) => patchAdmiral({ reserveFiveHourPct })}
              />
              <PercentField
                id="agency-reserve-7d"
                label="Weekly limit reserve in percent"
                prefix="Week"
                value={agency.admiral.reserveSevenDayPct}
                fallback={DEFAULT_AGENCY_SETTINGS.admiral.reserveSevenDayPct}
                onCommit={(reserveSevenDayPct) => patchAdmiral({ reserveSevenDayPct })}
              />
            </div>
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            No new Claude crew work starts once your Claude Code usage reaches these, so some is
            left for you. Crew already at work finish their turn. Work starts again when the window
            resets.
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.reserveFiveHourPct" />
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.reserveSevenDayPct" />
        </div>

        <div>
          <SettingRow label="Nudges per crew member">
            <BoundedNumber
              id="agency-nudge-limit"
              label="Nudges per crew member"
              value={agency.admiral.nudgeLimit}
              min={0}
              max={NUDGE_LIMIT_MAX}
              fallback={DEFAULT_AGENCY_SETTINGS.admiral.nudgeLimit}
              onCommit={(nudgeLimit) => patchAdmiral({ nudgeLimit })}
            />
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            How many times the Admiral may nudge a crew member that stops without reporting. After
            that, its step is blocked.
          </p>
          <AdmiralChangeNote marks={marks} settingKey="agency.admiral.nudgeLimit" />
        </div>

        <div>
          <SettingRow label="Permission card expiry">
            <BoundedNumber
              id="agency-permission-expiry"
              label="Permission card expiry in seconds"
              value={agency.admiral.permissionExpirySec}
              min={PERMISSION_EXPIRY_MIN_SEC}
              max={PERMISSION_EXPIRY_MAX_SEC}
              fallback={DEFAULT_AGENCY_SETTINGS.admiral.permissionExpirySec}
              onCommit={(permissionExpirySec) => patchAdmiral({ permissionExpirySec })}
            />
          </SettingRow>
          <p className="text-xs text-fleet-text-subtle mt-1">
            Seconds you have to answer a crew permission card before it is denied. Past about 5
            minutes, the crew member stops waiting and asks in its pane.
          </p>
        </div>

        <ClientFileEditor />
      </div>
    </div>
  );
}
