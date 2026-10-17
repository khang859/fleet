import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type {
  ProjectMemberSetup,
  ProjectSetup as Setup,
  RepoFile,
  SetupScan
} from '../../../../shared/agency-projects';
import {
  AdmiralSays,
  OnboardingButton,
  OnboardingCard,
  SectionLabel,
  textInputCls
} from './onboarding-ui';
import { NOTE_DOT, repoNotes } from './onboarding-view';

/**
 * Setup, step 2: what a read-only scan of the repository found, for the
 * client to check, fix and save. The scan runs in main and runs nothing from
 * the repository; saving writes only to Fleet's own folder, and "Share with
 * team" is the one action that writes into the repository, uncommitted.
 */
export function ProjectSetup({ repo }: { repo: AgencyRepoRef }): React.JSX.Element {
  const [scan, setScan] = useState<SetupScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [imports, setImports] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [shared, setShared] = useState<string[] | null>(null);

  // Keyed on the repository's fields, not the object: a redraw of the workspace
  // hands over an equal copy, and a fresh scan would throw away the client's edits.
  const { repoId, root, name } = repo;
  useEffect(() => {
    let live = true;
    window.fleet.agency.projects
      .scan({ repoId, root, name })
      .then((found) => {
        if (!live) return;
        setScan(found);
        setSetup(found.setup);
        setImports(new Set(found.setup.imports.map((i) => i.path)));
      })
      .catch((err: unknown) => live && setError(String(err)));
    return () => {
      live = false;
    };
  }, [repoId, root, name]);

  if (error !== null) {
    return (
      <Centered>
        <p className="max-w-md text-[13px] text-fleet-text-muted">
          Setup could not read {repo.name}: {error}
        </p>
      </Centered>
    );
  }
  if (scan === null || setup === null) {
    return (
      <Centered>
        <span className="flex items-center gap-2 text-[13px] text-fleet-text-muted">
          <Loader2 size={14} className="animate-spin" /> Reading {repo.name}. Nothing runs.
        </span>
      </Centered>
    );
  }

  const member = setup.members[0];
  const setMember = (patch: Partial<ProjectMemberSetup>): void =>
    setSetup({ ...setup, members: [{ ...member, ...patch }, ...setup.members.slice(1)] });

  const toggleImport = (file: RepoFile): void => {
    const next = new Set(imports);
    if (next.has(file.path)) next.delete(file.path);
    else next.add(file.path);
    setImports(next);
    // The team's setup file is not copied: importing it means taking its findings.
    if (file.kind === 'setup' && next.has(file.path) && scan.teamSetup !== null) {
      setSetup({ ...scan.teamSetup, name: setup.name });
    }
  };

  const request = { repo, setup, imports: [...imports] };
  const run = (kind: 'save' | 'share'): void => {
    setBusy(kind);
    setError(null);
    const done =
      kind === 'save'
        ? window.fleet.agency.projects.saveSetup({ ...request, finish: true }).then(() => {})
        : window.fleet.agency.projects.shareSetup(request).then(setShared);
    done.catch((err: unknown) => setError(String(err))).finally(() => setBusy(null));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-[960px] flex-col gap-4 px-5 py-5">
          <AdmiralSays>
            I read <span className="font-semibold">{repo.name}</span> at {scan.readFrom}. Nothing
            ran and nothing changed. Check what I found and fix anything I got wrong. It is all
            saved in Fleet, so no commit is needed.
          </AdmiralSays>
          <RepoCard scan={scan} member={member} onChange={setMember} />
          {scan.repoFiles.length > 0 && (
            <FoundCard files={scan.repoFiles} imports={imports} onToggle={toggleImport} />
          )}
          <OnboardingCard>
            <SectionLabel>PERMISSIONS</SectionLabel>
            <p className="mt-2 text-xs text-fleet-text-secondary">
              Crew use your logins and tools on this Mac. I answer their permission prompts.
            </p>
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              I ask you first: merge, production deploy, deletes, and anything outside the plan.
            </p>
          </OnboardingCard>
        </div>
      </div>
      <footer className="shrink-0 border-t border-fleet-border bg-fleet-bg">
        <div className="mx-auto flex w-full max-w-[960px] flex-wrap items-center justify-end gap-2 px-5 py-3">
          <p className="mr-auto min-w-0 text-[11px] text-fleet-text-subtle">
            {shared !== null
              ? `Copied to ${shared.join(' and ')}. Nothing is committed.`
              : scan.saved
                ? 'Showing the setup you saved before.'
                : 'Saved in Fleet, not in the repository.'}
          </p>
          <OnboardingButton disabled={busy !== null} onClick={() => run('share')}>
            {busy === 'share' ? 'Sharing…' : 'Share with team'}
          </OnboardingButton>
          <OnboardingButton kind="primary" disabled={busy !== null} onClick={() => run('save')}>
            {busy === 'save' ? 'Saving…' : 'Looks right'}
          </OnboardingButton>
        </div>
      </footer>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center px-6 text-center">
      {children}
    </div>
  );
}

const list = (items: string[]): string => items.join(', ');
const parseList = (text: string): string[] =>
  text
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function RepoCard({
  scan,
  member,
  onChange
}: {
  scan: SetupScan;
  member: ProjectMemberSetup;
  onChange: (patch: Partial<ProjectMemberSetup>) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const stack = [...member.stack, member.packageManager].filter(Boolean).join(' · ');
  return (
    <OnboardingCard>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SectionLabel note={`read from ${scan.readFrom}`}>REPO</SectionLabel>
        </div>
        <button
          type="button"
          onClick={() => setEditing(!editing)}
          className="text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
        >
          {editing ? 'Done' : 'Edit'}
        </button>
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 text-xs">
        <Row label="Stack">
          {editing ? (
            <ListInput
              label="Stack"
              value={member.stack}
              onChange={(stack) => onChange({ stack })}
            />
          ) : (
            stack || <None>not recognized</None>
          )}
        </Row>
        <Row label="New worktree">
          {editing ? (
            <div className="flex flex-wrap items-center gap-2">
              <input
                aria-label="New worktree command"
                value={member.setupCommand}
                onChange={(e) => onChange({ setupCommand: e.target.value })}
                className={`${textInputCls} min-w-[200px] flex-1 font-mono`}
              />
              <label className="flex items-center gap-1.5 text-fleet-text-muted">
                stops after
                <input
                  type="number"
                  min={1}
                  max={120}
                  aria-label="Minutes before the worktree command stops"
                  value={Math.round(member.setupTimeoutSec / 60)}
                  onChange={(e) =>
                    onChange({
                      setupTimeoutSec: Math.min(120, Math.max(1, Number(e.target.value) || 1)) * 60
                    })
                  }
                  className={`${textInputCls} w-14`}
                />
                min
              </label>
            </div>
          ) : member.setupCommand === '' ? (
            <None>nothing to run</None>
          ) : (
            <span className="font-mono text-fleet-text">
              {member.setupCommand}
              <span className="font-sans text-fleet-text-subtle">
                {' '}
                · stops after {Math.round(member.setupTimeoutSec / 60)} min
              </span>
            </span>
          )}
        </Row>
        <Row label="Crew checks">
          {editing ? (
            <ListInput
              label="Crew checks"
              value={member.checkCommands}
              onChange={(checkCommands) => onChange({ checkCommands })}
            />
          ) : (
            <Mono items={member.checkCommands} empty="none found" />
          )}
        </Row>
        <Row label="CI checks">
          {editing ? (
            <ListInput
              label="CI checks"
              value={member.checks}
              onChange={(checks) => onChange({ checks })}
            />
          ) : (
            <Mono items={member.checks} empty="no workflows found" />
          )}
        </Row>
        <Row label="Must pass">
          {editing ? (
            <ListInput
              label="Must pass"
              value={member.requiredChecks}
              onChange={(requiredChecks) => onChange({ requiredChecks })}
            />
          ) : (
            <Mono items={member.requiredChecks} empty="none required" />
          )}
        </Row>
        <Row label="Review bot">
          {editing ? (
            <ListInput
              label="Review bots"
              value={member.reviewBots}
              onChange={(reviewBots) => onChange({ reviewBots })}
            />
          ) : (
            <Mono items={member.reviewBots} empty="none" />
          )}
        </Row>
        <Row label="Default branch" last>
          {editing ? (
            <input
              aria-label="Default branch"
              value={member.defaultBranch ?? ''}
              onChange={(e) => onChange({ defaultBranch: e.target.value.trim() || null })}
              className={`${textInputCls} w-48 font-mono`}
            />
          ) : (
            <span className="font-mono text-fleet-text">
              {member.defaultBranch ?? <None>unknown</None>}
            </span>
          )}
        </Row>
      </dl>
      <ul className="mt-3 flex flex-col gap-1.5 text-xs text-fleet-text-secondary">
        {repoNotes(scan, member).map((n) => (
          <li key={n.text} className="flex items-start gap-2">
            <span className={`mt-[5px] size-1.5 shrink-0 rounded-full ${NOTE_DOT[n.tone]}`} />
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
    </OnboardingCard>
  );
}

function Row({
  label,
  last = false,
  children
}: {
  label: string;
  last?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const line = last ? '' : 'border-b border-fleet-border';
  return (
    <>
      <dt className={`flex items-center py-2 text-fleet-text-muted ${line}`}>{label}</dt>
      <dd className={`min-w-0 py-2 break-words text-fleet-text ${line}`}>{children}</dd>
    </>
  );
}

function None({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-fleet-text-subtle">{children}</span>;
}

function Mono({ items, empty }: { items: string[]; empty: string }): React.JSX.Element {
  if (items.length === 0) return <None>{empty}</None>;
  return <span className="font-mono text-fleet-text">{items.join(' · ')}</span>;
}

/** A list edited as one comma-separated line, read back when the field is left. */
function ListInput({
  label,
  value,
  onChange
}: {
  label: string;
  value: string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const joined = list(value);
  const [text, setText] = useState(joined);
  // A change from elsewhere, such as importing the team's setup, replaces what is shown.
  useEffect(() => setText(joined), [joined]);
  return (
    <input
      aria-label={label}
      value={text}
      placeholder="comma-separated"
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(parseList(text))}
      className={`${textInputCls} w-full font-mono`}
    />
  );
}

const FILE_ROLE: Record<RepoFile['kind'], string> = {
  setup: 'Team setup · fills in the findings above',
  role: 'Role from a teammate',
  playbook: 'Playbook from a teammate',
  agent: 'Agent · becomes a role',
  skill: 'Skill · crew use it in place',
  instructions: 'Crew read these as is',
  other: 'Jobs never read it'
};

function FoundCard({
  files,
  imports,
  onToggle
}: {
  files: RepoFile[];
  imports: ReadonlySet<string>;
  onToggle: (file: RepoFile) => void;
}): React.JSX.Element {
  return (
    <OnboardingCard tone="amber">
      <SectionLabel tone="amber" note="jobs use these only if you import them">
        FOUND IN THE REPO
      </SectionLabel>
      <ul className="mt-2 flex flex-col">
        {files.map((f) => (
          <li key={f.path} className="flex min-h-9 flex-wrap items-center gap-x-3 gap-y-1 py-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-fleet-text">
              {f.path}
            </span>
            <span className="text-xs text-fleet-text-muted">{FILE_ROLE[f.kind]}</span>
            <span className="flex w-[84px] justify-end">
              {f.disposition === 'importable' ? (
                imports.has(f.path) ? (
                  <button
                    type="button"
                    onClick={() => onToggle(f)}
                    aria-pressed
                    title="Ignore it instead"
                    className="flex items-center gap-1 rounded-md bg-green-500/10 px-2.5 py-1.5 text-xs text-green-600 transition hover:bg-green-500/15 focus-ring dark:text-green-400"
                  >
                    <Check size={12} strokeWidth={3} /> Imported
                  </button>
                ) : (
                  <OnboardingButton onClick={() => onToggle(f)}>Import</OnboardingButton>
                )
              ) : (
                <span className="text-[11px] text-fleet-text-subtle">
                  {f.disposition === 'in-place' ? 'In place' : 'Not used'}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </OnboardingCard>
  );
}
