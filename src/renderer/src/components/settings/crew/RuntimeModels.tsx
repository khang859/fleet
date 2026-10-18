import { useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import {
  AT_ONCE_MAX,
  type CrewModel,
  type CrewRuntime,
  type CrewRuntimeView,
  type RoleDraft
} from '../../../../../shared/agency-crew';
import type { CrewRuntimeSettings } from '../../../../../shared/agency';
import { useSettingsStore } from '../../../store/settings-store';
import { useAdmiralMarks } from '../../../hooks/use-admiral-marks';
import { AdmiralChangeNote } from '../AdmiralChangeNote';
import { modelCost, providerLabel, TONE_TEXT, usedBy } from './runtime-view';

const HEAD = 'text-[11px] font-semibold tracking-wider text-fleet-text-secondary';
/** Narrow, the cost goes under the model's name, so the name keeps its room. */
const COLS =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,110px)_44px] gap-3 px-3 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,150px)_minmax(0,130px)_44px]';
const WIDE = 'hidden @2xl:block';
/** Past this many models the list gets a filter. */
const FILTER_FROM = 12;

type Row = { id: string | undefined; name: string; cost: string; missing?: boolean };

/** The runtime's settings, and the call that changes them. */
function useCrewSettings(
  runtime: CrewRuntime
): [CrewRuntimeSettings | null, (patch: Partial<CrewRuntimeSettings>) => void] {
  const settings = useSettingsStore((s) => s.settings?.agency.crew[runtime] ?? null);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  return [settings, (patch) => void updateSettings({ agency: { crew: { [runtime]: patch } } })];
}

function rowsOf(runtime: CrewRuntime, view: CrewRuntimeView, picked: string): Row[] {
  const own =
    runtime === 'claude'
      ? "Claude Code's default"
      : `eva's default${view.server?.model ? `: ${view.server.model}` : ''}`;
  const listed = (view.models ?? []).map((m: CrewModel) => ({
    id: m.id,
    name: m.id,
    cost: modelCost(runtime, m)
  }));
  const gone =
    picked !== '' && view.models !== null && !listed.some((r) => r.id === picked)
      ? [{ id: picked, name: picked, cost: 'Not listed', missing: true }]
      : [];
  return [{ id: undefined, name: own, cost: '' }, ...gone, ...listed];
}

/**
 * The Models table: what crew of the runtime can run on, what each costs,
 * which roles use it, and the default for roles that name no model.
 */
export function RuntimeModels(props: {
  runtime: CrewRuntime;
  view: CrewRuntimeView;
  roles: RoleDraft[];
}): React.JSX.Element {
  const { runtime, view } = props;
  const [settings, patch] = useCrewSettings(runtime);
  const marks = useAdmiralMarks(null);
  const [filter, setFilter] = useState('');
  const picked = settings?.defaultModel ?? '';
  const fallback = picked === '' ? undefined : picked;
  const all = rowsOf(runtime, view, picked);
  const needle = filter.trim().toLowerCase();
  const rows =
    needle === ''
      ? all
      : all.filter((r) => r.id === fallback || r.name.toLowerCase().includes(needle));
  const source =
    runtime === 'claude'
      ? 'Names Claude Code takes for --model'
      : view.models === null
        ? 'The server did not list them'
        : `From ${providerLabel(view.server?.provider ?? 'eva')} · tool calls only`;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h4 className={HEAD}>MODELS</h4>
        <span className="flex-1 text-[11px] text-fleet-text-subtle">{source}</span>
        {all.length > FILTER_FROM && (
          <input
            type="search"
            aria-label="Filter models"
            placeholder="Filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-6 w-40 rounded border border-fleet-border-strong bg-fleet-bg px-2 text-xs text-fleet-text placeholder:text-fleet-text-subtle focus-ring"
          />
        )}
      </div>
      <div className="overflow-hidden rounded-md border border-fleet-border bg-fleet-bg">
        <div
          className={`${COLS} border-b border-fleet-border py-1.5 text-[11px] text-fleet-text-subtle`}
        >
          <span>Model</span>
          <span className={WIDE}>{runtime === 'claude' ? 'Cost' : 'Per M tokens · context'}</span>
          <span>Used by</span>
          <span className="text-right">Default</span>
        </div>
        <div role="radiogroup" aria-label="Default model" className="max-h-[296px] overflow-y-auto">
          {rows.map((row) => (
            <ModelRow
              key={row.id ?? ''}
              row={row}
              on={row.id === fallback}
              used={usedBy(runtime, row.id, fallback, props.roles)}
              onPick={() => patch({ defaultModel: row.id ?? '' })}
            />
          ))}
          {rows.length === 0 && (
            <p className="px-3 py-2 text-xs text-fleet-text-subtle">No model matches.</p>
          )}
        </div>
      </div>
      <p className="text-[11px] text-fleet-text-subtle">
        The default is for roles that name no model. A role whose model is no longer listed shows
        &quot;model missing&quot;.
      </p>
      <AdmiralChangeNote marks={marks} settingKey={`agency.crew.${runtime}.defaultModel`} />
    </div>
  );
}

function ModelRow(props: {
  row: Row;
  on: boolean;
  used: string;
  onPick: () => void;
}): React.JSX.Element {
  const { row } = props;
  const cost = `truncate font-mono text-[11px] ${row.missing ? TONE_TEXT.fail : 'text-fleet-text-muted'}`;
  return (
    <div
      className={`${COLS} items-center border-b border-fleet-border/60 py-1.5 text-xs last:border-b-0`}
    >
      <span className="flex min-w-0 flex-col">
        <span
          className={`truncate ${row.id === undefined ? 'text-fleet-text-secondary' : 'font-mono text-[11px] text-fleet-text'}`}
          title={row.name}
        >
          {row.name}
        </span>
        {row.cost !== '' && <span className={`${cost} @2xl:hidden`}>{row.cost}</span>}
      </span>
      <span className={`${cost} ${WIDE}`}>{row.cost}</span>
      <span
        className={`truncate ${props.used === 'No roles' ? 'text-fleet-text-subtle' : 'text-fleet-text-muted'}`}
        title={props.used}
      >
        {props.used}
      </span>
      <span className="flex justify-end">
        <button
          type="button"
          role="radio"
          aria-checked={props.on}
          aria-label={`Default model ${row.name}`}
          onClick={props.onPick}
          className={`flex h-4 w-4 items-center justify-center rounded-full border-[1.5px] focus-ring ${
            props.on
              ? 'border-blue-400'
              : 'border-fleet-text-subtle/60 hover:border-fleet-text-subtle'
          }`}
        >
          {props.on && <span className="h-2 w-2 rounded-full bg-blue-400" />}
        </button>
      </span>
    </div>
  );
}

const AT_ONCE: Record<CrewRuntime, { name: string; note: string }> = {
  claude: {
    name: 'Claude crew at once',
    note: 'Few Claude crew per job keeps usage ordinary. New hires pause while you are limited.'
  },
  eva: {
    name: 'eva crew at once',
    note: 'More steps wait for a free place. Default 4 for a remote server, 1 for a local one.'
  }
};

/** How many crew of the runtime work at once, over all jobs. */
export function AtOnce(props: { runtime: CrewRuntime; view: CrewRuntimeView }): React.JSX.Element {
  const [settings, patch] = useCrewSettings(props.runtime);
  const marks = useAdmiralMarks(null);
  const value = settings?.atOnce ?? props.view.defaultAtOnce;
  const { name, note } = AT_ONCE[props.runtime];
  const step =
    'flex h-[30px] w-[30px] items-center justify-center text-fleet-text-secondary transition-colors hover:text-fleet-text focus-ring disabled:opacity-40';
  return (
    <div>
      <div className="flex items-center gap-3.5 rounded-lg border border-fleet-border bg-fleet-bg px-3.5 py-2.5">
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm font-medium text-fleet-text">{name}</span>
          <span className="text-xs text-fleet-text-subtle">{note}</span>
        </div>
        <div
          role="group"
          aria-label={name}
          className="flex shrink-0 items-center rounded-md border border-fleet-border-strong bg-fleet-surface"
        >
          <button
            type="button"
            aria-label="Fewer"
            disabled={value <= 1}
            onClick={() => patch({ atOnce: value - 1 })}
            className={step}
          >
            <Minus size={14} />
          </button>
          <span className="w-8 text-center font-mono text-sm text-fleet-text" aria-live="polite">
            {value}
          </span>
          <button
            type="button"
            aria-label="More"
            disabled={value >= AT_ONCE_MAX}
            onClick={() => patch({ atOnce: value + 1 })}
            className={step}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <AdmiralChangeNote marks={marks} settingKey={`agency.crew.${props.runtime}.atOnce`} />
    </div>
  );
}
