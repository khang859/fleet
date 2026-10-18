import { CircleAlert } from 'lucide-react';
import {
  CREW_RUNTIMES,
  RUNTIME_LABEL,
  runtimeProblems,
  runtimeWarnings,
  type CrewModel,
  type CrewRuntime,
  type CrewRuntimeView,
  type RoleDraft
} from '../../../../../shared/agency-crew';
import { useSettingsStore } from '../../../store/settings-store';
import { ModelPicker } from '../../agent/settings/ModelSelect';
import { modelMissing, rolesUsing } from './role-draft';
import { modelFigures } from './runtime-view';

const CAPTION = 'text-xs text-fleet-text-muted';

/** What each runtime runs on, as the Runs on cards say it. */
function runsOn(view: CrewRuntimeView | undefined, runtime: CrewRuntime): string {
  if (runtime === 'claude') return 'Your Claude plan. The real Claude Code app in a Fleet pane.';
  const server = view?.server ?? null;
  if (server === null) return "eva's model server.";
  if (server.provider === 'openrouter')
    return 'Your OpenRouter key. Any model that can call tools.';
  if (server.local) return `Your own model server at ${server.baseUrl ?? 'localhost'}.`;
  return `The model server at ${server.baseUrl ?? 'the address eva has'}.`;
}

/** A runtime's status from its checks: ready, a warning, or the first problem. */
function status(view: CrewRuntimeView | undefined): { text: string; tone: string } {
  if (view === undefined) return { text: 'Checking…', tone: 'bg-fleet-text-subtle' };
  const { check } = view;
  const problem = runtimeProblems(check).at(0);
  if (problem !== undefined) return { text: problem, tone: 'bg-red-500' };
  const ready = check.version === null ? 'Ready' : `Ready · ${check.version}`;
  const warning = runtimeWarnings(check).at(0);
  if (warning !== undefined) return { text: warning, tone: 'bg-amber-400' };
  return { text: ready, tone: 'bg-emerald-500' };
}

/** What a role's work counts toward, beside its model. */
function costNote(runtime: CrewRuntime, view: CrewRuntimeView | undefined): string {
  if (runtime === 'claude') {
    return "Counts toward the job's share of your weekly Claude limit, not dollars.";
  }
  return view?.server?.local === true
    ? "Runs on your own server, so it adds nothing to the job's dollar budget."
    : "Paid per token to the model server. Counts toward the job's dollar budget.";
}

function modelMeta(runtime: CrewRuntime, model: CrewModel): string {
  if (runtime === 'claude') return `claude --model ${model.id}`;
  return modelFigures(model, true) ?? 'Listed by the server';
}

/** The line under the Model picker: the default, the picked model, or a typed id. */
function modelLine(
  draft: RoleDraft,
  picked: CrewModel | undefined,
  fleetDefault: string,
  view?: CrewRuntimeView
): string {
  if (draft.model !== undefined) {
    return picked ? modelMeta(draft.runtime, picked) : `${draft.model}, a model id you typed.`;
  }
  if (fleetDefault !== '') return `The default from the Runtimes tab: ${fleetDefault}.`;
  if (draft.runtime === 'claude') return 'Claude Code uses its own default model.';
  const fallback = view?.server?.model;
  return fallback ? `eva's default: ${fallback}.` : "eva uses its server's default model.";
}

/** The Runs on cards: one per runtime, with what it runs on and whether it is ready. */
export function RuntimeChoice(props: {
  value: CrewRuntime;
  runtimes: CrewRuntimeView[] | null;
  onPick: (runtime: CrewRuntime) => void;
}): React.JSX.Element {
  return (
    <div role="radiogroup" aria-label="Runs on" className="grid grid-cols-1 gap-2 @lg:grid-cols-2">
      {CREW_RUNTIMES.map((runtime) => {
        const on = props.value === runtime;
        const view = props.runtimes?.find((r) => r.check.runtime === runtime);
        const s = status(view);
        return (
          <button
            key={runtime}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => props.onPick(runtime)}
            className={`flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-left transition-colors focus-ring ${
              on
                ? 'border-blue-400/60 bg-blue-400/[0.08]'
                : 'border-fleet-border bg-fleet-bg hover:border-fleet-border-strong'
            }`}
          >
            <span
              className={`mt-0.5 h-3.5 w-3.5 shrink-0 rounded-full ${
                on ? 'border-4 border-blue-400 bg-fleet-bg' : 'border border-fleet-text-subtle'
              }`}
            />
            <span className="flex min-w-0 flex-col gap-px">
              <span className="text-sm font-semibold text-fleet-text">
                {RUNTIME_LABEL[runtime]}
              </span>
              <span className="text-xs text-fleet-text-muted">{runsOn(view, runtime)}</span>
              <span className="flex items-center gap-1.5 text-[11px] text-fleet-text-subtle">
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${s.tone}`} />
                <span className="min-w-0 truncate" title={s.text}>
                  {s.text}
                </span>
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * The Model box: the picker, with each model's cost, context and how many
 * roles use it, then what the pick means for the job's budget.
 */
export function ModelField(props: {
  draft: RoleDraft;
  view: CrewRuntimeView | undefined;
  /** Every role as its draft has it. */
  roles: RoleDraft[];
  onModel: (model: string | undefined) => void;
}): React.JSX.Element {
  const { draft, view } = props;
  const models = view?.models ?? null;
  const rows = (models ?? []).map((m) => ({ id: m.id, name: m.id, model: m }));
  const used = (id: string): string => {
    const n = rolesUsing(props.roles, draft.runtime, id);
    return n === 0 ? '' : n === 1 ? ' · 1 role' : ` · ${n} roles`;
  };
  const picked = rows.find((r) => r.id === draft.model)?.model;
  const fleetDefault = useSettingsStore(
    (s) => s.settings?.agency.crew[draft.runtime].defaultModel ?? ''
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-fleet-border bg-fleet-bg px-3 py-2.5 @lg:flex-row @lg:items-start">
      <div className="shrink-0 space-y-1 @lg:w-[240px]">
        <span className={CAPTION}>Model</span>
        <ModelPicker
          models={rows}
          value={draft.model ?? null}
          onChange={(model) => props.onModel(model ?? undefined)}
          allowNone
          noneLabel="Runtime default"
          allowCustom={draft.runtime === 'claude' || models === null}
          renderMeta={(row) => (
            <span className="mt-0.5 block truncate text-[11px] text-fleet-text-muted">
              {modelMeta(draft.runtime, row.model)}
              {used(row.id)}
            </span>
          )}
        />
      </div>
      <div className="min-w-0 flex-1 space-y-0.5 @lg:pt-5">
        {modelMissing(draft, models) ? (
          <p className="flex items-start gap-1.5 text-xs text-red-600 dark:text-red-400">
            <CircleAlert size={13} className="mt-px shrink-0" />
            <span>
              Model missing: eva&apos;s server does not list {draft.model}. A plan with this role
              cannot be approved until you pick another.
            </span>
          </p>
        ) : (
          <p className="text-xs text-fleet-text-secondary">
            {modelLine(draft, picked, fleetDefault, view)}
          </p>
        )}
        {draft.runtime === 'eva' && models === null && view !== undefined && (
          <p className="text-[11px] text-fleet-text-subtle">
            eva&apos;s model list could not be read, so any id is taken.
          </p>
        )}
        <p className="text-[11px] text-fleet-text-subtle">{costNote(draft.runtime, view)}</p>
      </div>
    </div>
  );
}
