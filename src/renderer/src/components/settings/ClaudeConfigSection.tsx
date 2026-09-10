import { useEffect, useMemo, useState } from 'react';
import { useSettingsStore } from '../../store/settings-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useCwdStore } from '../../store/cwd-store';
import { useClaudeConfigStore, isDirty } from '../../store/claude-config-store';
import { resolveClaudeConfig, resolveClaudeFilePath } from '../../../../shared/claude-config';
import type { ClaudeConfigScope, ClaudeFileKind } from '../../../../shared/claude-config';
import { PRECEDENCE_SENTENCE } from '../../../../shared/claude-settings-precedence';
import { ClaudeConfigRawEditor } from './ClaudeConfigRawEditor';
import { ClaudeConfigForm } from './ClaudeConfigForm';
import { ClaudeConfigSaveBar } from './ClaudeConfigSaveBar';
import type { SettingsSectionProps } from './SettingsTab';

/**
 * Settings > Claude Config.
 *
 * Edits the Claude Code files a user would otherwise have to open a hidden
 * folder to reach. Everything that outlives a remount - the drafts, the two
 * project directories, the selected scope - lives in `claude-config-store`,
 * because this component is unmounted whenever the user visits another
 * settings page, and the hooks panel here invites exactly that trip.
 */

const SCOPES: ClaudeConfigScope[] = ['user', 'project', 'projectLocal'];

/**
 * The picker's options: a short name, and under it the fact the name hides.
 *
 * "Project local" says nothing about being private, and "Project" says nothing
 * about reaching the whole team. That is the mistake worth designing out - a
 * personal setting committed to a shared repository - and it has to be legible
 * at the moment of choosing, not after switching.
 */
const SCOPE_TABS: Record<ClaudeConfigScope, { name: string; consequence: string }> = {
  user: { name: 'User', consequence: 'Everywhere' },
  project: { name: 'Project', consequence: 'Shared with your team' },
  projectLocal: { name: 'Project local', consequence: 'Only you, not committed' }
};

const ROOT_RULE_LABELS: Record<string, string> = {
  worktreeMainCheckout: "the worktree's main checkout",
  repositoryRoot: 'the git repository root',
  sessionDirectory: 'the chosen folder'
};

function SegmentedControl<T extends string>({
  value,
  options,
  onChange
}: {
  value: T;
  options: Array<{ id: T; label: string; sublabel: string }>;
  onChange: (id: T) => void;
}): React.JSX.Element {
  return (
    <div className="inline-flex w-fit rounded-md border border-fleet-border-strong bg-fleet-surface-2 p-0.5">
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          className={`rounded px-3 py-1.5 text-left transition-colors ${
            value === option.id
              ? 'bg-fleet-surface-3 text-fleet-text'
              : 'text-fleet-text-secondary hover:text-fleet-text'
          }`}
        >
          <span className="block text-xs">{option.label}</span>
          <span className="block text-[10px] text-fleet-text-subtle">{option.sublabel}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * The folder the user is working in.
 *
 * Not the active pane's: this page lives in the Settings tab, and that tab is a
 * pane of its own whose `cwd` is `/`. Asking the active pane would point every
 * project scope at the filesystem root. The first tab that actually runs
 * something is the honest answer, and the user can pick another folder.
 */
function firstWorkingDirectory(): string {
  const state = useWorkspaceStore.getState();
  const cwds = useCwdStore.getState().cwds;
  for (const tab of state.workspace.tabs) {
    if (tab.type !== undefined && tab.type !== 'terminal' && tab.type !== 'agent') continue;
    const paneCwd = tab.splitRoot.type === 'leaf' ? cwds.get(tab.splitRoot.id) : undefined;
    const dir = paneCwd ?? tab.cwd;
    if (dir && dir !== '/') return dir;
  }
  return '';
}

/**
 * One resolved path, stated as a sentence rather than laid out as a row.
 *
 * The path is the fact, the rule is why that path, and the override is the last
 * word of the same sentence. A labelled two-column row for something the user
 * reads once and changes almost never costs more vertical space than it earns.
 */
function PathLine({
  path,
  rule,
  action,
  missing,
  onPick
}: {
  path: string;
  rule: string;
  action: string;
  missing?: boolean;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <p className="text-[11px] leading-relaxed text-fleet-text-secondary">
      {path ? (
        <span className="font-mono text-fleet-text" title={path}>
          {path}
        </span>
      ) : (
        <span className="text-fleet-text-subtle">No folder chosen</span>
      )}
      {missing ? <span className="text-fleet-text-subtle"> - not created yet</span> : null}
      {' - '}
      {rule}{' '}
      <button
        onClick={onPick}
        className="fleet-accent-text underline underline-offset-2 transition active:scale-[0.97]"
      >
        {action}
      </button>
    </p>
  );
}

/** Quieter than the scope control above it, so the two do not compete. */
function TextTabs<T extends string>({
  value,
  options,
  onChange,
  mono
}: {
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (id: T) => void;
  mono?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          className={`border-b-2 pb-1 text-xs transition-colors ${mono ? 'font-mono' : ''} ${
            value === option.id
              ? 'border-fleet-text text-fleet-text'
              : 'border-transparent text-fleet-text-secondary hover:text-fleet-text'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function ClaudeConfigSection({ onNavigate }: SettingsSectionProps): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const activeWorkspaceId = useWorkspaceStore((s) => s.workspace.id);

  const scope = useClaudeConfigStore((s) => s.scope);
  const kind = useClaudeConfigStore((s) => s.kind);
  const configDir = useClaudeConfigStore((s) => s.configDir);
  const sessionDir = useClaudeConfigStore((s) => s.sessionDir);
  const localSettingsRoot = useClaudeConfigStore((s) => s.localSettingsRoot);
  const localRootRule = useClaudeConfigStore((s) => s.localRootRule);
  const documents = useClaudeConfigStore((s) => s.documents);
  const setScope = useClaudeConfigStore((s) => s.setScope);
  const setKind = useClaudeConfigStore((s) => s.setKind);
  const setConfigDir = useClaudeConfigStore((s) => s.setConfigDir);
  const adoptSessionDir = useClaudeConfigStore((s) => s.adoptSessionDir);
  const pinLocalRoot = useClaudeConfigStore((s) => s.pinLocalRoot);
  const load = useClaudeConfigStore((s) => s.load);

  const [view, setView] = useState<'form' | 'raw'>('form');

  // The user scope follows the same assignment new terminals get, so a
  // workspace that overrides its Claude folder edits that folder's files.
  const resolvedUserDir = useMemo(() => {
    const copilot = settings?.copilot;
    if (!copilot) return '';
    return resolveClaudeConfig({
      defaultDir: copilot.claudeConfigDir,
      overrideDir: copilot.workspaceOverrides[activeWorkspaceId]?.claudeConfigDir,
      homeDir: window.fleet.homeDir
    }).path;
  }, [settings?.copilot, activeWorkspaceId]);

  useEffect(() => {
    if (resolvedUserDir) setConfigDir(resolvedUserDir);
  }, [resolvedUserDir, setConfigDir]);

  // Preselect the folder the user is actually working in. Unpinned, so a later
  // hand-picked folder is not overwritten by the next visit to this page.
  useEffect(() => {
    const cwd = firstWorkingDirectory();
    if (cwd) void adoptSessionDir(cwd, false);
  }, [adoptSessionDir]);

  const dirs = useMemo(
    () => ({
      configDir,
      sessionDir: sessionDir || undefined,
      localSettingsRoot: localSettingsRoot || undefined
    }),
    [configDir, sessionDir, localSettingsRoot]
  );

  // Project local has no memory file, so the tab disappears and the selection
  // falls back rather than leaving the page pointing at nothing.
  const effectiveKind: ClaudeFileKind = scope === 'projectLocal' ? 'settings' : kind;
  const path = resolveClaudeFilePath({ scope, kind: effectiveKind, dirs });

  useEffect(() => {
    if (path) void load(scope, effectiveKind, path);
  }, [scope, path, effectiveKind, load]);

  // Every scope's settings file, so the page can say which file a value
  // actually comes from instead of showing three files that look independent.
  const loadAll = useClaudeConfigStore((s) => s.load);
  useEffect(() => {
    for (const other of SCOPES) {
      const otherPath = resolveClaudeFilePath({ scope: other, kind: 'settings', dirs });
      if (otherPath) void loadAll(other, 'settings', otherPath);
    }
  }, [dirs, loadAll]);

  // Hooks installed from the Copilot page, or an edit made in a terminal, land
  // while this page is open. Re-read on focus rather than leaving stale text.
  const refreshFromDisk = useClaudeConfigStore((s) => s.refreshFromDisk);
  useEffect(() => {
    if (!path) return;
    const onFocus = (): void => void refreshFromDisk(scope, effectiveKind, path);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshFromDisk, scope, effectiveKind, path]);

  const doc = path ? documents[path] : undefined;

  const pickFolder = async (target: 'session' | 'localRoot'): Promise<void> => {
    const picked = await window.fleet.showFolderPicker();
    if (!picked) return;
    if (target === 'session') await adoptSessionDir(picked, true);
    else pinLocalRoot(picked);
  };

  const needsFolder = scope !== 'user' && !path;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <SegmentedControl
          value={scope}
          options={SCOPES.map((s) => ({
            id: s,
            label: SCOPE_TABS[s].name,
            sublabel: SCOPE_TABS[s].consequence
          }))}
          onChange={setScope}
        />

        <div className="space-y-1">
          <p className="text-xs leading-relaxed text-fleet-text-secondary">{PRECEDENCE_SENTENCE}</p>
          <p className="text-[11px] leading-relaxed text-fleet-text-subtle">
            Managed settings deployed by an administrator, <code>--settings</code>, command-line
            flags and environment variables override all three and are not shown here.
          </p>
        </div>

        {scope === 'user' ? (
          <PathLine
            path={path ?? ''}
            missing={doc !== undefined && !doc.exists}
            rule="in the Claude folder assigned to this workspace."
            action="Change"
            onPick={() => onNavigate?.('workspaces', activeWorkspaceId)}
          />
        ) : null}

        {scope === 'project' ? (
          <PathLine
            path={path ?? ''}
            missing={doc !== undefined && !doc.exists}
            rule="in the folder a session runs in."
            action="Change"
            onPick={() => void pickFolder('session')}
          />
        ) : null}

        {scope === 'projectLocal' ? (
          <PathLine
            path={path ?? ''}
            missing={doc !== undefined && !doc.exists}
            rule={`resolved from ${ROOT_RULE_LABELS[localRootRule]}.`}
            action="Change"
            onPick={() => void pickFolder('localRoot')}
          />
        ) : null}

        {!needsFolder ? (
          <div className="flex items-center justify-between gap-4 border-b border-fleet-border">
            {scope === 'projectLocal' ? (
              <span className="border-b-2 border-fleet-text pb-1 font-mono text-xs text-fleet-text">
                settings.json
              </span>
            ) : (
              <TextTabs
                mono
                value={effectiveKind}
                options={[
                  { id: 'settings' as ClaudeFileKind, label: 'settings.json' },
                  { id: 'memory' as ClaudeFileKind, label: 'CLAUDE.md' }
                ]}
                onChange={setKind}
              />
            )}
            {effectiveKind === 'settings' ? (
              <TextTabs
                value={view}
                options={[
                  { id: 'form' as const, label: 'Form' },
                  { id: 'raw' as const, label: 'Raw' }
                ]}
                onChange={setView}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      {needsFolder ? (
        <div className="rounded border border-fleet-border-strong bg-fleet-surface-2 px-3 py-6 text-center text-sm text-fleet-text-secondary">
          Choose a folder to edit this scope.
        </div>
      ) : (
        <>
          {effectiveKind === 'settings' && view === 'form' ? (
            <ClaudeConfigForm scope={scope} path={path ?? ''} dirs={dirs} />
          ) : (
            <ClaudeConfigRawEditor path={path ?? ''} kind={effectiveKind} />
          )}

          <ClaudeConfigSaveBar
            scope={scope}
            kind={effectiveKind}
            path={path ?? ''}
            dirty={isDirty(doc)}
            onNavigate={onNavigate}
          />
        </>
      )}
    </div>
  );
}
