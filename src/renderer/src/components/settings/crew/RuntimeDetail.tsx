import { Lock } from 'lucide-react';
import {
  RUNTIME_LABEL,
  type CrewRuntime,
  type CrewRuntimeView,
  type RoleDraft,
  type RuntimeCheckItem,
  type RuntimeTestResult
} from '../../../../../shared/agency-crew';
import { useWorkspaceStore } from '../../../store/workspace-store';
import { AtOnce, PermissionMode, RuntimeModels } from './RuntimeModels';
import { checkSummary, runtimeFacts, shownChecks, TONE_DOT, TONE_TEXT } from './runtime-view';

export type TestState = { running: boolean; result: RuntimeTestResult | null };

const HEAD = 'text-[11px] font-semibold tracking-wider text-fleet-text-secondary';
const BUTTON =
  'h-7 shrink-0 rounded-md border border-fleet-border-strong bg-fleet-surface-3 px-2.5 text-xs text-fleet-text transition-colors hover:bg-fleet-surface-2 focus-ring disabled:opacity-60';

const LOCK_NOTE: Record<CrewRuntime, string> = {
  claude: 'Fleet never reads or changes your Claude login. Crew use it the way you do.',
  eva: 'Read from ~/.eva/config.toml. Fleet reads only the server, never the key.'
};

/** One runtime: where it is, its account or server, the Test button, its checks and models. */
export function RuntimeDetail(props: {
  runtime: CrewRuntime;
  view: CrewRuntimeView;
  repoRoot: string;
  roles: RoleDraft[];
  test: TestState | null;
  onTest: () => void;
}): React.JSX.Element {
  const { runtime, view, test } = props;
  const openResumeTab = useWorkspaceStore((s) => s.openResumeTab);
  const label = test?.running ? 'Testing…' : test?.result ? 'Test again' : 'Test';

  return (
    <section
      aria-label={RUNTIME_LABEL[runtime]}
      className="flex flex-col gap-4 rounded-lg border border-fleet-border bg-fleet-surface px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <h3 className="text-base font-semibold text-fleet-text">{RUNTIME_LABEL[runtime]}</h3>
        {view.check.version !== null && (
          <span className="rounded-full bg-fleet-surface-3 px-2 py-px font-mono text-[11px] text-fleet-text-muted">
            {view.check.version}
          </span>
        )}
        <span className="flex-1" />
        {view.check.path !== null && (
          <span
            className="min-w-0 truncate font-mono text-[11px] text-fleet-text-muted"
            title={view.check.path}
          >
            {view.check.path}
          </span>
        )}
        <button type="button" disabled={test?.running} onClick={props.onTest} className={BUTTON}>
          {label}
        </button>
      </div>

      <div className="space-y-1.5">
        <dl className="grid grid-cols-[96px_minmax(0,1fr)] gap-y-1 text-xs">
          {runtimeFacts(runtime, view).map((f) => (
            <div key={f.label} className="contents">
              <dt className="text-fleet-text-subtle">{f.label}</dt>
              <dd
                className={`min-w-0 break-words ${f.mono ? 'font-mono text-[11px]' : ''} ${
                  f.tone ? TONE_TEXT[f.tone] : 'text-fleet-text'
                }`}
              >
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center gap-2.5 rounded-md bg-fleet-bg px-2.5 py-2 text-xs text-fleet-text-subtle">
          <Lock size={13} className="shrink-0" />
          <span className="flex-1">{LOCK_NOTE[runtime]}</span>
          {runtime === 'eva' && (
            <button
              type="button"
              onClick={() => openResumeTab(props.repoRoot, 'eva --config', 'eva settings')}
              className={BUTTON}
            >
              Edit in eva
            </button>
          )}
        </div>
      </div>

      {test !== null && <TestRows runtime={runtime} test={test} />}

      <Checks checks={shownChecks(runtime, view)} />
      <RuntimeModels runtime={runtime} view={view} roles={props.roles} />
      <AtOnce runtime={runtime} view={view} />
      <PermissionMode runtime={runtime} />
    </section>
  );
}

function TestRows({ runtime, test }: { runtime: CrewRuntime; test: TestState }): React.JSX.Element {
  const { result } = test;
  return (
    <div role="status" className="space-y-1 rounded-md bg-fleet-bg px-2.5 py-2 text-xs">
      {test.running && (
        <p className="text-fleet-text-muted">
          Starting {RUNTIME_LABEL[runtime]} in a hidden pane. This can take up to two minutes.
        </p>
      )}
      {!test.running && result?.ok === false && <p className={TONE_TEXT.fail}>{result.reason}</p>}
      {!test.running &&
        result?.ok === true &&
        result.rows.map((row) => (
          <div key={row.what} className="flex items-start gap-2">
            <span className={`w-3 shrink-0 text-center ${TONE_TEXT[row.ok ? 'ok' : 'fail']}`}>
              {row.ok ? '✓' : '×'}
            </span>
            <span className="flex-1 text-fleet-text">{row.what}</span>
            <span
              className={`min-w-0 max-w-[60%] text-right text-[11px] ${
                row.ok ? 'text-fleet-text-subtle' : TONE_TEXT.fail
              }`}
            >
              {row.detail}
            </span>
          </div>
        ))}
    </div>
  );
}

const MARK: Record<RuntimeCheckItem['state'], string> = { ok: '✓', warn: '!', fail: '×' };

function Checks({ checks }: { checks: RuntimeCheckItem[] }): React.JSX.Element {
  const summary = checkSummary(checks);
  return (
    <div className="space-y-1">
      <div className="flex items-baseline gap-2">
        <h4 className={HEAD}>CHECKS</h4>
        <span className={`text-[11px] ${TONE_TEXT[summary.tone]}`}>{summary.text}</span>
      </div>
      <ul className="grid grid-cols-1 gap-x-5 @2xl:grid-cols-2">
        {checks.map((c) => (
          <li
            key={c.name}
            className="flex items-start gap-2 border-b border-fleet-border/60 py-1.5 last:border-b-0 @2xl:[&:nth-last-child(2):nth-child(odd)]:border-b-0"
          >
            <span
              aria-hidden
              className={`mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-fleet-bg ${TONE_DOT[c.state]}`}
            >
              {MARK[c.state]}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-xs font-medium text-fleet-text">{c.name}</span>
              <span
                className={`text-[11px] ${c.state === 'ok' ? 'text-fleet-text-subtle' : TONE_TEXT[c.state]}`}
              >
                {c.note}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
