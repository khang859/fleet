import { useState } from 'react';
import {
  CREW_RUNTIMES,
  RUNTIME_LABEL,
  type CrewRuntime,
  type CrewRuntimeView,
  type RoleDraft,
  type RuntimeTestResult
} from '../../../../../shared/agency-crew';
import type { AgencyRepoRef } from '../../../../../shared/agency';
import { RuntimeDetail, type TestState } from './RuntimeDetail';
import { rolesLine, runtimeState, TONE_DOT, TONE_TEXT } from './runtime-view';

type Props = {
  runtimes: CrewRuntimeView[] | null;
  /** Every role as its draft has it. */
  roles: RoleDraft[];
};

/**
 * The Runtimes tab of Settings › Agency › Crew: one card per runtime, and
 * the picked one's checks, models, test and how many of its crew work at
 * once. A test result stays while the page shows the same project.
 */
export function RuntimesTab({
  repo,
  ...props
}: Props & { repo: AgencyRepoRef | null }): React.JSX.Element | null {
  if (repo === null) return null;
  return <Runtimes key={repo.repoId} repoId={repo.repoId} repoRoot={repo.root} {...props} />;
}

function Runtimes(props: Props & { repoId: string; repoRoot: string }): React.JSX.Element {
  const [picked, setPicked] = useState<CrewRuntime>('claude');
  const [tests, setTests] = useState<Partial<Record<CrewRuntime, TestState>>>({});
  const view = props.runtimes?.find((r) => r.check.runtime === picked);

  const runTest = async (runtime: CrewRuntime): Promise<void> => {
    const set = (state: TestState): void => setTests((all) => ({ ...all, [runtime]: state }));
    set({ running: true, result: tests[runtime]?.result ?? null });
    const result: RuntimeTestResult = await window.fleet.agency.crew
      .testRuntime(props.repoId, runtime)
      .catch((e: unknown) => ({ ok: false, reason: e instanceof Error ? e.message : String(e) }));
    set({ running: false, result });
  };

  return (
    <div className="flex flex-col gap-5 @3xl:flex-row @3xl:items-start">
      <div className="shrink-0 space-y-2 @3xl:w-[260px] @5xl:w-[300px]">
        <p className="text-xs text-fleet-text-muted">
          A role runs on one of these. Fleet checks each one before it shows a plan.
        </p>
        {CREW_RUNTIMES.map((runtime) => (
          <RuntimeCard
            key={runtime}
            runtime={runtime}
            view={props.runtimes?.find((r) => r.check.runtime === runtime)}
            roles={props.roles}
            on={runtime === picked}
            onPick={() => setPicked(runtime)}
          />
        ))}
      </div>
      <div className="min-w-0 flex-1">
        {view === undefined ? (
          <p className="pt-2 text-sm text-fleet-text-muted">Checking {RUNTIME_LABEL[picked]}…</p>
        ) : (
          <RuntimeDetail
            key={picked}
            runtime={picked}
            view={view}
            repoRoot={props.repoRoot}
            roles={props.roles}
            test={tests[picked] ?? null}
            onTest={() => void runTest(picked)}
          />
        )}
      </div>
    </div>
  );
}

function RuntimeCard(props: {
  runtime: CrewRuntime;
  view: CrewRuntimeView | undefined;
  roles: RoleDraft[];
  on: boolean;
  onPick: () => void;
}): React.JSX.Element {
  const state = runtimeState(props.view);
  const version = props.view?.check.version ?? null;
  return (
    <button
      type="button"
      aria-pressed={props.on}
      onClick={props.onPick}
      className={`flex w-full flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus-ring ${
        props.on
          ? 'border-blue-400/50 bg-fleet-surface'
          : 'border-fleet-border hover:border-fleet-border-strong'
      }`}
    >
      <span className="flex items-baseline gap-2">
        <span className="flex-1 text-sm font-semibold text-fleet-text">
          {RUNTIME_LABEL[props.runtime]}
        </span>
        {version !== null && (
          <span className="font-mono text-[11px] text-fleet-text-muted">{version}</span>
        )}
      </span>
      <span className="text-xs text-fleet-text-muted">{rolesLine(props.runtime, props.roles)}</span>
      <span className={`flex items-center gap-1.5 text-[11px] ${TONE_TEXT[state.tone]}`}>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${TONE_DOT[state.tone]}`} />
        {state.text}
      </span>
    </button>
  );
}
