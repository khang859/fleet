import { useEffect, useRef, useState } from 'react';
import { Command as CommandPrimitive } from 'cmdk';
import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, ChevronRight, GitBranch } from 'lucide-react';
import { popperAnim } from '../../lib/motion';
import { Overlay } from '../Overlay';
import { cleanIpcError } from '../../lib/ipc-error';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useToastStore } from '../../store/toast-store';
import type {
  WorktreeCreateResponse,
  WorktreePrepareResponse,
  WorktreeSetup
} from '../../../../shared/ipc-api';
import type { PathContext } from '../../../../shared/shell-profiles';

/** The tab a worktree is made from, and the repository it is in. */
export type WorktreeTarget = {
  tabId: string;
  repoPath: string;
  pathContext?: PathContext;
};

const fieldClass =
  'w-full bg-fleet-surface-2 text-sm text-fleet-text rounded px-2 py-1 border border-fleet-border-strong placeholder:text-fleet-text-subtle focus-ring';

/** Opens the new worktree in a group with its tab, and says which listed files were not copied. */
function openWorktree(
  target: WorktreeTarget,
  made: WorktreeCreateResponse,
  setupCommand: string | undefined
): void {
  useWorkspaceStore
    .getState()
    .createWorktreeGroup(
      target.tabId,
      made.worktreePath,
      made.branchName,
      target.repoPath,
      setupCommand
    );
  if (made.skipped.length > 0) {
    const list = made.skipped.map((s) => `${s.path} (${s.reason})`).join(', ');
    useToastStore.getState().show(`Did not copy ${list}`, { duration: 8000 });
  }
}

/**
 * Names a new worktree and picks what it starts from, then makes it. The
 * repository's `.fleet/worktree.toml` setup can be read here before it runs,
 * so a command from a freshly cloned repository never runs unseen.
 */
export function CreateWorktreeDialog({
  target,
  onClose
}: {
  target: WorktreeTarget | null;
  onClose: () => void;
}): React.JSX.Element {
  const [info, setInfo] = useState<WorktreePrepareResponse | null>(null);
  const [branch, setBranch] = useState('');
  const [startFrom, setStartFrom] = useState('');
  const [runSetup, setRunSetup] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const branchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (target === null) return;
    let live = true;
    setInfo(null);
    setBranch('');
    setStartFrom('');
    setRunSetup(true);
    setSubmitting(false);
    setError(null);
    window.fleet.worktree
      .prepare({ repoPath: target.repoPath, pathContext: target.pathContext })
      .then((prepared) => {
        if (!live) return;
        setInfo(prepared);
        setStartFrom(prepared.current ?? 'HEAD');
      })
      .catch((err: unknown) => live && setError(cleanIpcError(String(err))));
    // One frame later: the panel is still animating in when `target` is set.
    const timer = setTimeout(() => branchRef.current?.focus(), 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [target]);

  const setupCommand = info?.setup?.setup ?? '';
  const canSubmit = target !== null && info !== null && startFrom !== '' && !submitting;

  const handleCreate = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const made = await window.fleet.worktree.create({
        repoPath: target.repoPath,
        pathContext: target.pathContext,
        branch: branch.trim() || undefined,
        startPoint: startFrom
      });
      openWorktree(target, made, runSetup && setupCommand !== '' ? setupCommand : undefined);
      onClose();
    } catch (err) {
      setError(cleanIpcError(String(err)));
      setSubmitting(false);
    }
  };

  return (
    <Overlay
      open={target !== null}
      onClose={onClose}
      closeOnEscape={!submitting}
      closeOnBackdrop={!submitting}
      panelClassName="w-[460px] max-w-[90vw] bg-fleet-surface border border-fleet-border-strong rounded-lg shadow-xl p-4"
    >
      <h2 className="text-sm font-medium text-fleet-text mb-3">New worktree</h2>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-fleet-text-muted block mb-1">Branch name</label>
          <input
            ref={branchRef}
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate();
            }}
            placeholder="Leave empty for a random name"
            spellCheck={false}
            className={fieldClass}
          />
        </div>

        <StartFromPicker info={info} value={startFrom} onChange={setStartFrom} />

        {info !== null && (
          <SetupRow
            setup={info.setup}
            setupError={info.setupError}
            runSetup={runSetup}
            onRunSetupChange={setRunSetup}
          />
        )}

        {error && <p className="text-xs text-red-400 break-words">{error}</p>}
      </div>

      <div className="flex justify-end gap-2 mt-4">
        <button
          disabled={submitting}
          onClick={onClose}
          className="px-3 py-1 text-xs bg-fleet-surface-3 hover:bg-fleet-surface-3 rounded border border-fleet-border-strong text-fleet-text-secondary transition active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Cancel
        </button>
        <button
          disabled={!canSubmit}
          onClick={() => void handleCreate()}
          className="px-3 py-1 text-xs fleet-accent-bg text-white rounded transition active:scale-[0.97] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {submitting ? 'Creating…' : 'Create worktree'}
        </button>
      </div>
    </Overlay>
  );
}

/**
 * A one-line button that opens a searchable list of the repository's
 * branches. Any other ref, like a commit, can be typed into the search.
 */
function StartFromPicker({
  info,
  value,
  onChange
}: {
  info: WorktreePrepareResponse | null;
  value: string;
  onChange: (ref: string) => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const typed = query.trim();
  const pick = (ref: string): void => {
    onChange(ref);
    setQuery('');
    setOpen(false);
  };

  return (
    <div>
      <label className="text-xs text-fleet-text-muted block mb-1">Start from</label>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            disabled={info === null}
            className={`${fieldClass} flex items-center gap-2 disabled:opacity-60`}
          >
            <GitBranch size={13} className="shrink-0 text-fleet-text-muted" />
            <span className="flex-1 text-left truncate font-mono">
              {info === null ? 'Loading branches…' : value}
            </span>
            <ChevronDown size={13} className="shrink-0 text-fleet-text-muted" />
          </button>
        </Popover.Trigger>
        {/* No portal: inside the dialog's focus trap, a portalled search box could not take focus. */}
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={4}
          className={`z-50 w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-lg border border-fleet-border-strong bg-fleet-surface shadow-xl ${popperAnim}`}
        >
          {/* Opens with the chosen ref highlighted, so Enter keeps it. */}
          <CommandPrimitive label="Start from" defaultValue={value}>
            <CommandPrimitive.Input
              value={query}
              onValueChange={setQuery}
              placeholder="Search branches, or type a commit"
              spellCheck={false}
              className="w-full bg-transparent text-sm text-fleet-text px-2 py-1.5 border-b border-fleet-border outline-none placeholder:text-fleet-text-subtle"
            />
            <CommandPrimitive.List className="max-h-[200px] overflow-y-auto p-1">
              {info?.refs.map((ref) => (
                <RefItem key={ref} value={ref} selected={ref === value} onSelect={pick} />
              ))}
              {typed !== '' && !info?.refs.includes(typed) && (
                <RefItem value={typed} label={`Use “${typed}”`} selected={false} onSelect={pick} />
              )}
            </CommandPrimitive.List>
          </CommandPrimitive>
        </Popover.Content>
      </Popover.Root>
    </div>
  );
}

function RefItem({
  value,
  label,
  selected,
  onSelect
}: {
  value: string;
  label?: string;
  selected: boolean;
  onSelect: (ref: string) => void;
}): React.JSX.Element {
  return (
    <CommandPrimitive.Item
      value={value}
      // The typed-ref row matches whatever was typed, so it never filters out.
      forceMount={label !== undefined}
      onSelect={() => onSelect(value)}
      className="flex items-center gap-2 h-6 px-2 rounded text-xs text-fleet-text-secondary cursor-pointer select-none data-[selected=true]:bg-fleet-surface-3 data-[selected=true]:text-fleet-text"
    >
      <Check size={12} className={selected ? 'shrink-0 fleet-accent-text' : 'shrink-0 invisible'} />
      <span className="truncate font-mono">{label ?? value}</span>
    </CommandPrimitive.Item>
  );
}

/** "3 commands · copies 2 files": what the setup does, in a few words. */
function setupSummary(setup: WorktreeSetup): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lines = setup.setup === '' ? 0 : setup.setup.split('\n').length;
  return [
    lines > 0 ? plural(lines, 'command') : null,
    setup.copy.length > 0 ? `copies ${plural(setup.copy.length, 'file')}` : null
  ]
    .filter(Boolean)
    .join(' · ');
}

/** What `.fleet/worktree.toml` does to the new worktree as one row, its details behind Show. */
function SetupRow({
  setup,
  setupError,
  runSetup,
  onRunSetupChange
}: {
  setup: WorktreeSetup | null;
  setupError: string | null;
  runSetup: boolean;
  onRunSetupChange: (run: boolean) => void;
}): React.JSX.Element {
  const [shown, setShown] = useState(false);

  if (setupError !== null) {
    return <p className="text-xs text-red-400 whitespace-pre-wrap break-words">{setupError}</p>;
  }
  if (setup === null) {
    return (
      <p className="text-xs text-fleet-text-subtle">
        Add <code className="font-mono">.fleet/worktree.toml</code> to the repository to run a setup
        and copy .env files into each new worktree.
      </p>
    );
  }

  const hasCommands = setup.setup !== '';
  return (
    <div className="rounded border border-fleet-border bg-fleet-surface-2">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <label className="flex items-center gap-2 text-xs text-fleet-text-secondary shrink-0">
          <input
            type="checkbox"
            checked={hasCommands && runSetup}
            disabled={!hasCommands}
            onChange={(e) => onRunSetupChange(e.target.checked)}
            className="fleet-accent-input"
          />
          Run setup
        </label>
        <span className="text-xs text-fleet-text-subtle truncate">{setupSummary(setup)}</span>
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => setShown(!shown)}
          className="ml-auto flex items-center gap-0.5 text-xs text-fleet-text-muted hover:text-fleet-text shrink-0 rounded focus-ring"
        >
          {shown ? 'Hide' : 'Show'}
          <ChevronRight size={12} className={`transition ${shown ? 'rotate-90' : ''}`} />
        </button>
      </div>
      {shown && (
        <div className="border-t border-fleet-border px-2 py-1.5 space-y-1.5">
          {hasCommands && (
            <pre className="max-h-24 overflow-auto text-xs font-mono text-fleet-text-secondary whitespace-pre-wrap break-all">
              {setup.setup}
            </pre>
          )}
          {setup.copy.length > 0 && (
            <p className="text-xs text-fleet-text-subtle break-words">
              Copies from the main checkout:{' '}
              <span className="font-mono text-fleet-text-secondary">{setup.copy.join(', ')}</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
