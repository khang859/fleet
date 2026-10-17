import { useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { AdmiralGlyph } from './AdmiralGlyph';
import type { AgencyPreflight } from '../../../../shared/agency';
import { OnboardingButton, OnboardingCard, textInputCls, type CardTone } from './onboarding-ui';
import { pickBlocker, type FirstRunModel } from './onboarding-view';

/** A small text button in the Admiral's blue. */
const LINK_BUTTON =
  'text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300';

const INSTALL = {
  claude: 'https://docs.anthropic.com/en/docs/claude-code/setup',
  eva: 'https://github.com/khang859/eva',
  gh: 'https://cli.github.com'
};

export type FirstRunViewProps = {
  preflight: AgencyPreflight | null;
  checking: boolean;
  model: FirstRunModel;
  ghSkipped: boolean;
  onSaveKey: (key: string) => Promise<void>;
  onUseLocal: () => void;
  onChangeModel: () => void;
  onGhLogin: () => void;
  onCheckAgain: () => void;
  onSkipGh: () => void;
  onPick: () => void;
};

/** First run as drawn: three checks and the way on. The container is `AdmiralFirstRun`. */
export function FirstRunView(props: FirstRunViewProps): React.JSX.Element {
  const blocker = pickBlocker(props.preflight, props.model);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-[600px] flex-col gap-5 px-5 py-10">
        <div className="flex flex-col items-center gap-3 text-center">
          <span className="flex size-14 items-center justify-center rounded-full border border-fleet-border bg-fleet-surface">
            <AdmiralGlyph size={24} />
          </span>
          <h2 className="text-xl font-semibold text-fleet-text">Meet your Admiral</h2>
          <p className="max-w-[500px] text-[13px] leading-relaxed text-fleet-text-muted">
            You give the Admiral a brief. It plans the work, runs a crew of agents in Fleet panes,
            and only comes back with questions and results. Three quick checks first.
          </p>
        </div>

        <ModelStep {...props} />
        <CrewStep preflight={props.preflight} />
        <GitHubStep {...props} />

        <div className="flex flex-col items-center gap-2 pt-1">
          <OnboardingButton
            kind="primary"
            size="lg"
            disabled={blocker !== null}
            onClick={props.onPick}
          >
            Pick a project
          </OnboardingButton>
          {blocker !== null && <p className="text-xs text-fleet-text-muted">{blocker}</p>}
        </div>
      </div>
    </div>
  );
}

function StepHead({
  n,
  done,
  title,
  aside
}: {
  n: number;
  done: boolean;
  title: string;
  aside: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
          done
            ? 'bg-green-500/15 text-green-600 dark:text-green-400'
            : 'bg-fleet-surface-2 text-fleet-text'
        }`}
      >
        {done ? <Check size={12} strokeWidth={3} /> : n}
      </span>
      <span className="min-w-0 flex-1 text-[13px] font-semibold text-fleet-text">{title}</span>
      <span className="shrink-0 text-[11px] text-fleet-text-muted">{aside}</span>
    </div>
  );
}

/** The body of a step, lined up under its title rather than its number. */
function StepBody({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="mt-2 flex flex-col gap-2.5 pl-[30px]">{children}</div>;
}

function ModelStep({
  model,
  onSaveKey,
  onUseLocal,
  onChangeModel
}: FirstRunViewProps): React.JSX.Element {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = model.kind !== 'none';

  const save = (): void => {
    const trimmed = key.trim();
    if (trimmed === '' || saving) return;
    setSaving(true);
    setError(null);
    onSaveKey(trimmed)
      .then(() => setKey(''))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(false));
  };

  return (
    <OnboardingCard tone={done ? 'green' : 'blue'}>
      <StepHead n={1} done={done} title="The Admiral’s model" aside="Required" />
      <StepBody>
        {done ? (
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fleet-text-muted">
            <span className="font-medium text-fleet-text">
              {model.kind === 'openrouter' ? 'OpenRouter' : 'Local model'}
            </span>
            {model.model !== '' && (
              <>
                <span>·</span>
                <span className="font-mono text-[11px] text-fleet-text-secondary">
                  {model.model}
                </span>
              </>
            )}
            <span>·</span>
            <span>{model.kind === 'openrouter' ? 'key in Keychain' : 'on this Mac'}</span>
            <button type="button" onClick={onChangeModel} className={`ml-auto ${LINK_BUTTON}`}>
              Change
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-fleet-text-muted">
              The Admiral runs on your OpenRouter key or a local model. It never uses your Claude
              Code login.
            </p>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                save();
              }}
            >
              <input
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="OpenRouter key, sk-or-…"
                aria-label="OpenRouter key"
                autoComplete="off"
                spellCheck={false}
                className={`${textInputCls} min-w-[180px] flex-1 font-mono`}
              />
              <OnboardingButton type="submit" kind="primary" disabled={key.trim() === '' || saving}>
                {saving ? 'Saving…' : 'Save key'}
              </OnboardingButton>
              <OnboardingButton onClick={onUseLocal}>Use a local model</OnboardingButton>
            </form>
            {error !== null && <p className="text-xs text-red-500">{error}</p>}
          </>
        )}
      </StepBody>
    </OnboardingCard>
  );
}

function CrewStep({ preflight }: { preflight: AgencyPreflight | null }): React.JSX.Element {
  const any = preflight !== null && (preflight.claude.found || preflight.eva.found);
  const tone: CardTone = preflight === null ? 'plain' : any ? 'green' : 'amber';
  return (
    <OnboardingCard tone={tone}>
      <StepHead
        n={2}
        done={any}
        title="Your crew"
        aside={preflight === null ? 'Checking…' : any ? 'Found on this Mac' : 'Not found'}
      />
      <StepBody>
        {preflight === null ? (
          <span className="flex items-center gap-1.5 text-xs text-fleet-text-muted">
            <Loader2 size={12} className="animate-spin" /> Looking for Claude Code and eva…
          </span>
        ) : (
          <ul className="flex flex-col gap-1.5">
            <CrewLine
              name="Claude Code"
              found={preflight.claude.found}
              version={preflight.claude.version}
              note={
                preflight.claude.found ? 'runs in its own terminal, signed in by you' : 'not found'
              }
              installUrl={INSTALL.claude}
            />
            <CrewLine
              name="eva"
              found={preflight.eva.found}
              version={preflight.eva.version}
              note={
                preflight.eva.found
                  ? 'optional, cheaper for bulk work'
                  : 'not installed · optional, cheaper for bulk work'
              }
              installUrl={INSTALL.eva}
            />
          </ul>
        )}
      </StepBody>
    </OnboardingCard>
  );
}

function CrewLine({
  name,
  found,
  version,
  note,
  installUrl
}: {
  name: string;
  found: boolean;
  version: string | null;
  note: string;
  installUrl: string;
}): React.JSX.Element {
  return (
    <li className="flex items-start gap-2 text-xs leading-relaxed">
      <span
        className={`mt-[7px] size-1.5 shrink-0 rounded-full ${
          found ? 'bg-green-500' : 'border border-fleet-text-subtle'
        }`}
      />
      <span className="min-w-0 flex-1 text-fleet-text-muted">
        <span className="font-medium text-fleet-text">{name}</span>
        {version !== null && (
          <span className="ml-1.5 font-mono text-[11px] text-fleet-text-secondary">{version}</span>
        )}
        <span> · {note}</span>
      </span>
      {!found && <InstallLink url={installUrl} />}
    </li>
  );
}

function InstallLink({ url }: { url: string }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={() => void window.fleet.shell.openExternal(url)}
      className={`shrink-0 ${LINK_BUTTON}`}
    >
      How to install
    </button>
  );
}

function GitHubStep({
  preflight,
  checking,
  ghSkipped,
  onGhLogin,
  onCheckAgain,
  onSkipGh
}: FirstRunViewProps): React.JSX.Element {
  const gh = preflight?.gh;
  const signedIn = gh?.signedIn === true;
  const text =
    gh === undefined
      ? 'Checking the GitHub CLI…'
      : signedIn
        ? 'The GitHub CLI is signed in. Crew use it to push branches and open PRs.'
        : !gh.found
          ? 'The GitHub CLI is not installed. Crew use it to push branches and open PRs. Without it, crew leave local branches for you.'
          : ghSkipped
            ? 'Skipped for now. Crew leave local branches for you until the GitHub CLI is signed in.'
            : 'The GitHub CLI is not signed in. Crew use it to push branches and open PRs. Without it, crew leave local branches for you.';
  return (
    <OnboardingCard tone={signedIn ? 'green' : 'plain'}>
      <StepHead n={3} done={signedIn} title="GitHub sign-in" aside="Optional" />
      <StepBody>
        <p className="text-xs leading-relaxed text-fleet-text-muted">{text}</p>
        {gh !== undefined && !signedIn && (
          <div className="flex flex-wrap items-center gap-2">
            {gh.found ? (
              <OnboardingButton onClick={onGhLogin}>Run gh auth login</OnboardingButton>
            ) : (
              <OnboardingButton onClick={() => void window.fleet.shell.openExternal(INSTALL.gh)}>
                Install the GitHub CLI
              </OnboardingButton>
            )}
            <OnboardingButton onClick={onCheckAgain} disabled={checking}>
              {checking ? 'Checking…' : 'Check again'}
            </OnboardingButton>
            {!ghSkipped && (
              <OnboardingButton kind="ghost" onClick={onSkipGh}>
                Skip for now
              </OnboardingButton>
            )}
          </div>
        )}
      </StepBody>
    </OnboardingCard>
  );
}
