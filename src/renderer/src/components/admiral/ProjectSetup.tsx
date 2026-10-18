import { useEffect, useRef, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { diffLines, formatUnified, toHunks } from '../../../../shared/agent-diff';
import type { AgencyRepoRef } from '../../../../shared/agency';
import type {
  MemberScan,
  ProjectMemberSetup,
  ProjectSetup as Setup,
  RepoFile,
  SetupScan
} from '../../../../shared/agency-projects';
import {
  memberSettingKey,
  type AdmiralSettingMark,
  type MemberSettingField
} from '../../../../shared/agency-settings';
import { useAdmiralMarks } from '../../hooks/use-admiral-marks';
import { toggled } from '../../lib/toggled';
import { AdmiralChangeNote } from '../settings/AdmiralChangeNote';
import { AskAdmiralForm } from '../settings/AskAdmiral';
import {
  AdmiralSays,
  OnboardingButton,
  OnboardingCard,
  SectionLabel,
  textInputCls
} from './onboarding-ui';
import { DiffBody } from '../ui/DiffBody';
import { MissingCard } from './MissingCard';
import {
  memberOrder,
  NOTE_DOT,
  repoNotes,
  runsServers,
  serversNote,
  stackSlotsLabel
} from './onboarding-view';

/**
 * Setup, step 2: what a read-only scan of the repository found, for the
 * client to check, fix and save. The scan runs in main and runs nothing from
 * the repository; saving writes only to Fleet's own folder, and "Share with
 * team" is the one action that writes into the repository, uncommitted.
 */
export function ProjectSetup({ repo }: { repo: AgencyRepoRef }): React.JSX.Element {
  const edited = useRef(false);
  const { scan, setup, setSetup, imports, setImports, error, setError, reread } = useSetupScan(
    repo,
    edited
  );
  const [busy, setBusy] = useState<'save' | 'share' | null>(null);
  const [shared, setShared] = useState<string[] | null>(null);
  const [updates, setUpdates] = useState<ReadonlySet<string>>(new Set());
  const marks = useAdmiralMarks(repo.repoId);

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

  const setMember = (index: number, patch: Partial<ProjectMemberSetup>): void => {
    edited.current = true;
    setSetup({
      ...setup,
      members: setup.members.map((m, i) => (i === index ? { ...m, ...patch } : m))
    });
  };
  const workspace = scan.kind !== 'repo';

  const toggleImport = (file: RepoFile): void => {
    edited.current = true;
    const next = toggled(imports, file.path);
    setImports(next);
    // The team's setup file is not copied: importing it means taking its findings.
    // Only for the members this project has: a teammate's may hold others.
    if (file.kind === 'setup' && next.has(file.path) && scan.teamSetup !== null) {
      setSetup(withMembersFrom(setup, scan.teamSetup));
    }
  };

  const request = {
    repo,
    setup,
    imports: [...imports],
    updates: [...updates].filter((p) => imports.has(p))
  };
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
          <ScanIntro repo={repo} scan={scan} setup={setup} onCheckedOut={reread} />
          {setup.members.map((member, i) => (
            <RepoCard
              key={member.name}
              scan={scan}
              member={member}
              read={scan.members.find((m) => m.name === member.name) ?? scan.members[i]}
              title={workspace ? member.name : null}
              marks={marks}
              onChange={(patch) => setMember(i, patch)}
            />
          ))}
          <ProjectCards
            setup={setup}
            workspace={workspace}
            onChange={(patch) => {
              edited.current = true;
              setSetup({ ...setup, ...patch });
            }}
          />
          {scan.repoFiles.length > 0 && (
            <FoundCard
              repo={repo}
              files={scan.repoFiles}
              imports={imports}
              newer={new Set(scan.newer)}
              updates={updates}
              onToggle={toggleImport}
              onUpdate={(path) => setUpdates(toggled(updates, path))}
            />
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
          <AskCard repo={repo} />
        </div>
      </div>
      <footer className="shrink-0 border-t border-fleet-border bg-fleet-bg">
        <div className="mx-auto flex w-full max-w-[960px] flex-wrap items-center justify-end gap-2 px-5 py-3">
          <p className="mr-auto min-w-0 text-[11px] text-fleet-text-subtle">
            {shared !== null
              ? `Copied ${shared.length === 1 ? 'the setup' : `${shared.length} files`} to .fleet/. Nothing is committed.`
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

/**
 * `base` with each member `from` also has, at the same path, taken from
 * `from`: a teammate's shared setup, or the client's edits kept over a re-read.
 */
function withMembersFrom(base: Setup, from: Setup): Setup {
  return {
    ...base,
    members: base.members.map(
      (m) => from.members.find((f) => f.name === m.name && f.path === m.path) ?? m
    )
  };
}

/**
 * The scan behind the setup screen, read again when the Admiral changes the
 * saved setup or a member is checked out. A re-read keeps what the client
 * edited.
 */
type SetupScanState = {
  scan: SetupScan | null;
  setup: Setup | null;
  setSetup: (setup: Setup) => void;
  imports: ReadonlySet<string>;
  setImports: (imports: ReadonlySet<string>) => void;
  error: string | null;
  setError: (error: string | null) => void;
  reread: () => void;
};

function useSetupScan(repo: AgencyRepoRef, edited: React.RefObject<boolean>): SetupScanState {
  const [scan, setScan] = useState<SetupScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [imports, setImports] = useState<ReadonlySet<string>>(new Set());
  const [rereads, setRereads] = useState(0);
  // Keyed on the repository's fields, not the object: a redraw of the workspace
  // hands over an equal copy, and a fresh scan would throw away the client's edits.
  const { repoId, root, name } = repo;
  const admiralChanges = useAdmiralSetupChanges(repoId, edited);
  useEffect(() => {
    let live = true;
    window.fleet.agency.projects
      .scan({ repoId, root, name })
      .then((found) => {
        if (!live) return;
        setScan(found);
        if (edited.current) {
          setSetup((prev) => (prev === null ? found.setup : withMembersFrom(found.setup, prev)));
          return;
        }
        setSetup(found.setup);
        setImports(new Set(found.setup.imports.map((i) => i.path)));
      })
      .catch((err: unknown) => live && setError(String(err)));
    return () => {
      live = false;
    };
  }, [repoId, root, name, edited, admiralChanges, rereads]);
  const reread = (): void => setRereads((n) => n + 1);
  return { scan, setup, setSetup, imports, setImports, error, setError, reread };
}

/** What the Admiral says it read, what it could not, and the member order. */
function ScanIntro({
  repo,
  scan,
  setup,
  onCheckedOut
}: {
  repo: AgencyRepoRef;
  scan: SetupScan;
  setup: Setup;
  onCheckedOut: () => void;
}): React.JSX.Element {
  const workspace = scan.kind !== 'repo';
  return (
    <>
      <AdmiralSays>
        I read <span className="font-semibold">{repo.name}</span>
        {workspace
          ? `, ${membersRead(setup.members.length)} at their default branches`
          : ` at ${scan.members[0].readFrom}`}
        . Nothing ran and nothing changed. Check what I found and fix anything I got wrong. It is
        all saved in Fleet, so no commit is needed.
      </AdmiralSays>
      {scan.missing.length > 0 && (
        <MissingCard repo={repo} scan={scan} onCheckedOut={onCheckedOut} />
      )}
      {workspace && setup.members.length > 1 && (
        <OnboardingCard>
          <SectionLabel note="dependencies first">MEMBER ORDER</SectionLabel>
          <p className="mt-2 font-mono text-xs text-fleet-text">{memberOrder(setup)}</p>
          <p className="mt-1 text-xs text-fleet-text-muted">
            Crew set up members and merge their PRs in this order
            {scan.kind === 'submodules'
              ? ', and the umbrella moves to the merged commits last.'
              : '.'}
          </p>
        </OnboardingCard>
      )}
    </>
  );
}

/** `its one member`, `both members` or `all 4 members`. */
function membersRead(n: number): string {
  if (n === 1) return 'its one member';
  return n === 2 ? 'both members' : `all ${n} members`;
}

/**
 * Counts the Admiral's changes to the repository's saved setup, so the scan
 * runs again and shows them - unless the client is mid-edit, whose edits win.
 */
function useAdmiralSetupChanges(repoId: string, edited: React.RefObject<boolean>): number {
  const [changes, setChanges] = useState(0);
  useEffect(
    () =>
      window.fleet.agency.onChanged((change) => {
        if (change.settings === true && change.repoId === repoId && !edited.current) {
          setChanges((n) => n + 1);
        }
      }),
    [repoId, edited]
  );
  return changes;
}

/** "Ask the Admiral" in setup: the lobby is not on screen yet, so the answer waits there. */
function AskCard({ repo }: { repo: AgencyRepoRef }): React.JSX.Element {
  const [asked, setAsked] = useState(false);
  return (
    <OnboardingCard>
      <SectionLabel>ASK THE ADMIRAL</SectionLabel>
      <p className="mt-2 mb-2.5 text-xs text-fleet-text-secondary">
        {asked
          ? 'Asked. I answer in the lobby when setup is done.'
          : 'Not sure about something here? Ask, and I answer in the lobby when setup is done.'}
      </p>
      <AskAdmiralForm
        page="Project setup"
        projects={[repo]}
        placeholder="For example: which checks should crew run?"
        onSent={() => setAsked(true)}
      />
    </OnboardingCard>
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

/** `read from main`, with the member's path first in a workspace. */
function cardNote(member: ProjectMemberSetup, read: MemberScan, inWorkspace: boolean): string {
  const from = `read from ${read.readFrom}`;
  return inWorkspace && member.path !== '.' ? `${member.path} · ${from}` : from;
}

/** A setup card's heading: REPO, or the member's name and path, with Edit. */
function RepoCardHeader({
  member,
  read,
  title,
  editing,
  onEdit
}: {
  member: ProjectMemberSetup;
  read: MemberScan;
  title: string | null;
  editing: boolean;
  onEdit: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <SectionLabel note={cardNote(member, read, title !== null)}>
          {title?.toUpperCase() ?? 'REPO'}
        </SectionLabel>
      </div>
      <EditButton editing={editing} name={title} onClick={onEdit} />
    </div>
  );
}

function EditButton({
  editing,
  name,
  onClick
}: {
  editing: boolean;
  /** What it edits, for its accessible name when there are several. */
  name: string | null;
  onClick: () => void;
}): React.JSX.Element {
  const action = editing ? 'Done' : 'Edit';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={name === null ? undefined : `${action} ${name}`}
      className="text-xs text-blue-500 transition-colors hover:text-blue-400 focus-ring dark:text-blue-400 dark:hover:text-blue-300"
    >
      {action}
    </button>
  );
}

/** A setup command and the minutes before it stops, as inputs while editing. */
function SetupCommandField({
  label,
  command,
  timeoutSec,
  editing,
  onChange
}: {
  label: string;
  command: string;
  timeoutSec: number;
  editing: boolean;
  onChange: (patch: { setupCommand?: string; setupTimeoutSec?: number }) => void;
}): React.JSX.Element {
  if (!editing) {
    return command === '' ? (
      <None>nothing to run</None>
    ) : (
      <span className="font-mono text-fleet-text">
        {command}
        <span className="font-sans text-fleet-text-subtle">
          {' '}
          · stops after {Math.round(timeoutSec / 60)} min
        </span>
      </span>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        aria-label={`${label} command`}
        value={command}
        onChange={(e) => onChange({ setupCommand: e.target.value })}
        className={`${textInputCls} min-w-[200px] flex-1 font-mono`}
      />
      <label className="flex items-center gap-1.5 text-fleet-text-muted">
        stops after
        <input
          type="number"
          min={1}
          max={120}
          aria-label={`Minutes before the ${label.toLowerCase()} command stops`}
          value={Math.round(timeoutSec / 60)}
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
  );
}

/** What a new job workspace runs at its root once each member is set up. */
function WorkspaceSetupCard({
  setup,
  onChange
}: {
  setup: Setup;
  onChange: (patch: { setupCommand?: string; setupTimeoutSec?: number }) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  return (
    <OnboardingCard>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SectionLabel note="after each member's setup">WORKSPACE SETUP</SectionLabel>
        </div>
        <EditButton editing={editing} name="workspace setup" onClick={() => setEditing(!editing)} />
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 text-xs">
        <Row label="New workspace" last>
          <SetupCommandField
            label="New workspace"
            command={setup.setupCommand}
            timeoutSec={setup.setupTimeoutSec}
            editing={editing}
            onChange={onChange}
          />
        </Row>
      </dl>
    </OnboardingCard>
  );
}

type ProjectPatch = Partial<Pick<Setup, 'setupCommand' | 'setupTimeoutSec' | 'stackSlots'>>;

/** The cards for the whole project: the workspace setup, and the stack slots when it runs servers. */
function ProjectCards({
  setup,
  workspace,
  onChange
}: {
  setup: Setup;
  workspace: boolean;
  onChange: (patch: ProjectPatch) => void;
}): React.JSX.Element {
  return (
    <>
      {workspace && <WorkspaceSetupCard setup={setup} onChange={onChange} />}
      {runsServers(setup) && <ServersCard setup={setup} onChange={onChange} />}
    </>
  );
}

const SLOT_CHOICES = [null, 1, 2, 3, 4] as const;

/** How many steps that run the project's servers may run at once. */
function ServersCard({
  setup,
  onChange
}: {
  setup: Setup;
  onChange: (patch: ProjectPatch) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const fixed = setup.members.flatMap((m) => m.fixedPorts);
  return (
    <OnboardingCard>
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <SectionLabel note="each job workspace gets its own ports">SERVERS</SectionLabel>
        </div>
        <EditButton editing={editing} name="stack slots" onClick={() => setEditing(!editing)} />
      </div>
      <dl className="mt-3 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 text-xs">
        <Row label="Stack slots" last>
          {editing ? (
            <select
              aria-label="Stack slots"
              value={setup.stackSlots ?? ''}
              onChange={(e) =>
                onChange({ stackSlots: e.target.value === '' ? null : Number(e.target.value) })
              }
              className={`${textInputCls} w-32`}
            >
              {SLOT_CHOICES.map((n) => (
                <option key={n ?? 'none'} value={n ?? ''}>
                  {n ?? 'No limit'}
                </option>
              ))}
            </select>
          ) : (
            stackSlotsLabel(setup.stackSlots)
          )}
        </Row>
      </dl>
      <p className="mt-3 text-xs text-fleet-text-secondary">{serversNote(fixed)}</p>
    </OnboardingCard>
  );
}

function RepoCard({
  scan,
  member,
  read,
  title,
  marks,
  onChange
}: {
  scan: SetupScan;
  member: ProjectMemberSetup;
  read: MemberScan;
  /** The member's name, in a workspace; a one-repository project's card says REPO. */
  title: string | null;
  marks: AdmiralSettingMark[];
  onChange: (patch: Partial<ProjectMemberSetup>) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const changed = (...fields: MemberSettingField[]): React.ReactNode =>
    fields.map((field) => (
      <AdmiralChangeNote
        key={field}
        marks={marks}
        settingKey={memberSettingKey(member.name, field)}
      />
    ));
  const stack = [...member.stack, member.packageManager].filter(Boolean).join(' · ');
  return (
    <OnboardingCard>
      <RepoCardHeader
        member={member}
        read={read}
        title={title}
        editing={editing}
        onEdit={() => setEditing(!editing)}
      />
      <dl className="mt-3 grid grid-cols-[minmax(96px,max-content)_1fr] gap-x-4 text-xs">
        <Row label="Stack" note={changed('stack', 'packageManager')}>
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
        <Row label="New worktree" note={changed('setupCommand', 'setupTimeoutSec')}>
          <SetupCommandField
            label="New worktree"
            command={member.setupCommand}
            timeoutSec={member.setupTimeoutSec}
            editing={editing}
            onChange={onChange}
          />
        </Row>
        <ListRow
          label="Crew checks"
          inputLabel="Crew checks"
          value={member.checkCommands}
          empty="none found"
          editing={editing}
          note={changed('checkCommands')}
          onChange={(checkCommands) => onChange({ checkCommands })}
        />
        <ListRow
          label="CI checks"
          inputLabel="CI checks"
          value={member.checks}
          empty="no workflows found"
          editing={editing}
          note={changed('checks')}
          onChange={(checks) => onChange({ checks })}
        />
        <ListRow
          label="Must pass"
          inputLabel="Must pass"
          value={member.requiredChecks}
          empty="none required"
          editing={editing}
          note={changed('requiredChecks')}
          onChange={(requiredChecks) => onChange({ requiredChecks })}
        />
        <ListRow
          label="Review bot"
          inputLabel="Review bots"
          value={member.reviewBots}
          empty="none"
          editing={editing}
          note={changed('reviewBots')}
          onChange={(reviewBots) => onChange({ reviewBots })}
        />
        <Row label="Ports" note={changed('portVars')}>
          {editing ? (
            <ListInput
              label="Port variables"
              value={member.portVars}
              onChange={(portVars) => onChange({ portVars })}
            />
          ) : (
            <Ports member={member} />
          )}
        </Row>
        <Row label="Default branch" last note={changed('defaultBranch')}>
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
        {repoNotes(scan, member, read).map((n) => (
          <li key={n.text} className="flex items-start gap-2">
            <span className={`mt-[5px] size-1.5 shrink-0 rounded-full ${NOTE_DOT[n.tone]}`} />
            <span>{n.text}</span>
          </li>
        ))}
      </ul>
    </OnboardingCard>
  );
}

/** A list setting: a comma-separated input while editing, else the items. */
function ListRow({
  label,
  inputLabel,
  value,
  empty,
  editing,
  note,
  onChange
}: {
  label: string;
  inputLabel: string;
  value: string[];
  empty: string;
  editing: boolean;
  note: React.ReactNode;
  onChange: (value: string[]) => void;
}): React.JSX.Element {
  return (
    <Row label={label} note={note}>
      {editing ? (
        <ListInput label={inputLabel} value={value} onChange={onChange} />
      ) : (
        <Mono items={value} empty={empty} />
      )}
    </Row>
  );
}

function Row({
  label,
  last = false,
  note,
  children
}: {
  label: string;
  last?: boolean;
  /** "Changed by the Admiral" under the value, when it was. */
  note?: React.ReactNode;
  children: React.ReactNode;
}): React.JSX.Element {
  const line = last ? '' : 'border-b border-fleet-border';
  return (
    <>
      <dt className={`flex items-center py-2 text-fleet-text-muted ${line}`}>{label}</dt>
      <dd className={`min-w-0 py-2 break-words text-fleet-text ${line}`}>
        {children}
        {note}
      </dd>
    </>
  );
}

function None({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-fleet-text-subtle">{children}</span>;
}

/** A member's port variables, and the host ports its files fix. */
function Ports({ member }: { member: ProjectMemberSetup }): React.JSX.Element {
  if (member.portVars.length === 0 && member.fixedPorts.length === 0) {
    return <None>none found</None>;
  }
  return (
    <span className="font-mono text-fleet-text">
      {member.portVars.join(' · ')}
      {member.fixedPorts.map((f, i) => (
        <span key={f.port} className="font-sans text-fleet-text-secondary">
          {member.portVars.length > 0 || i > 0 ? ' · ' : ''}
          {f.service} fixed on <span className="font-mono text-fleet-text">{f.port}</span>
        </span>
      ))}
    </span>
  );
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
  repo,
  files,
  imports,
  newer,
  updates,
  onToggle,
  onUpdate
}: {
  repo: AgencyRepoRef;
  files: RepoFile[];
  imports: ReadonlySet<string>;
  /** Imported files the repository has a different version of. */
  newer: ReadonlySet<string>;
  /** Of those, the ones the client takes on save. */
  updates: ReadonlySet<string>;
  onToggle: (file: RepoFile) => void;
  onUpdate: (path: string) => void;
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
              <ImportToggle file={f} imported={imports.has(f.path)} onToggle={() => onToggle(f)} />
            </span>
            {imports.has(f.path) && newer.has(f.path) && (
              <NewerInRepo
                repo={repo}
                path={f.path}
                updating={updates.has(f.path)}
                onUpdate={() => onUpdate(f.path)}
              />
            )}
          </li>
        ))}
      </ul>
    </OnboardingCard>
  );
}

/** Import or ignore a file setup can import; say how crew use one it cannot. */
function ImportToggle({
  file,
  imported,
  onToggle
}: {
  file: RepoFile;
  imported: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  if (file.disposition !== 'importable') {
    return (
      <span className="text-[11px] text-fleet-text-subtle">
        {file.disposition === 'in-place' ? 'In place' : 'Not used'}
      </span>
    );
  }
  if (!imported) return <OnboardingButton onClick={onToggle}>Import</OnboardingButton>;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed
      title="Ignore it instead"
      className="flex items-center gap-1 rounded-md bg-green-500/10 px-2.5 py-1.5 text-xs text-green-600 transition hover:bg-green-500/15 focus-ring dark:text-green-400"
    >
      <Check size={12} strokeWidth={3} /> Imported
    </button>
  );
}

/**
 * An imported file the repository has a newer version of. Jobs keep using the
 * project's copy until the client reviews the change and takes it on save.
 */
function NewerInRepo({
  repo,
  path,
  updating,
  onUpdate
}: {
  repo: AgencyRepoRef;
  path: string;
  updating: boolean;
  onUpdate: () => void;
}): React.JSX.Element {
  const [diff, setDiff] = useState<string[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const review = (): void => {
    setOpen(!open);
    if (diff !== null) return;
    window.fleet.agency.projects
      .importDiff({ repo, path })
      .then((d) => setDiff(formatUnified(toHunks(diffLines(d.ours, d.theirs)), 400).split('\n')))
      .catch((err: unknown) => setError(String(err)));
  };

  return (
    <div className="flex w-full flex-col gap-2 pb-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="mr-auto text-xs text-amber-600 dark:text-amber-400">
          {updating
            ? 'Takes the repo version when you save.'
            : 'Newer in the repo. Jobs keep your copy until you update.'}
        </span>
        <OnboardingButton onClick={review}>{open ? 'Hide changes' : 'Review'}</OnboardingButton>
        <OnboardingButton kind={updating ? 'primary' : undefined} onClick={onUpdate}>
          {updating ? 'Keep mine' : 'Update'}
        </OnboardingButton>
      </div>
      {open &&
        (error !== null ? (
          <p className="text-xs text-fleet-text-muted">Could not read the change: {error}</p>
        ) : diff === null ? (
          <span className="flex items-center gap-2 text-xs text-fleet-text-muted">
            <Loader2 size={12} className="animate-spin" /> Reading both versions.
          </span>
        ) : diff.length === 1 && diff[0] === '' ? (
          <p className="text-xs text-fleet-text-muted">Only the line endings differ.</p>
        ) : (
          <DiffBody lines={diff} />
        ))}
    </div>
  );
}
