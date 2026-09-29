import { useState } from 'react';
import { Check, GitBranch, GitCommitHorizontal, Lock } from 'lucide-react';
import { headName, truncateBranch, type AgentGitHead } from '../../../../shared/agent-git';
import { AgentFolderSwitcher, FolderIcon } from './AgentFolderSwitcher';
import { isScratchDir } from '../../lib/scratch';

/**
 * Where the agent is working: the folder, and the branch inside it.
 *
 * Under the composer rather than in the status line above it, because this is a
 * property of the pane and not of the turn - it is true before the first message
 * and still true long after the last one, where everything in that row is about
 * the exchange that just happened.
 *
 * The folder half also fills a gap: it used to appear only on the empty pane and
 * vanish for good once anything had been said, which left a pane with a long
 * transcript unable to tell you which checkout it had been editing.
 */
export function AgentLocation({
  cwd,
  head,
  label,
  onMove
}: {
  cwd: string;
  head: AgentGitHead | null;
  /**
   * What to call the folder, when its own name is not the useful answer. The
   * scratch pane passes one: the basename there is `scratch`, which says where
   * the files are rather than what the pane is, and the path is still in the
   * tooltip for anyone who wants it.
   */
  label?: string;
  /**
   * Given while the folder can still change - before the first message. The
   * name becomes the menu that changes it; without this it is plain text.
   */
  onMove?: (
    folderPath: string,
    worktree?: { path: string; branchName: string; repoPath: string }
  ) => void;
}): React.JSX.Element {
  const name = head === null ? null : headName(head);
  const detached = head !== null && head.branch === null;

  return (
    // `px-4` to share the composer's left edge exactly, so the folder name
    // lines up with the box above it rather than sitting just inside it.
    <div className="mx-auto flex w-full max-w-2xl shrink-0 items-center gap-2 px-4 pb-3 text-[11px] text-fleet-text-subtle">
      {onMove ? (
        <AgentFolderSwitcher cwd={cwd} label={label ?? folderName(cwd)} onMove={onMove} />
      ) : (
        // Locked once the conversation has started. Same icon and place as the
        // switcher, so it reads as the same thing, now fixed - with the reason,
        // because a control that just stops working looks broken.
        <span
          // Same box as the switcher, border and all, so locking does not move it.
          className="flex min-w-0 shrink items-center gap-1 rounded border border-transparent px-1.5 py-0.5"
          title={`${cwd}\nThe folder is set for this chat. Start a new chat to work somewhere else.`}
        >
          <FolderIcon scratch={isScratchDir(cwd)} />
          <span className="truncate">{label ?? folderName(cwd)}</span>
          <Lock
            size={10}
            className="shrink-0 opacity-70"
            aria-label="Folder is set for this chat"
          />
        </span>
      )}
      {name !== null && <BranchChip name={name} op={head?.op ?? null} detached={detached} />}
    </div>
  );
}

function BranchChip({
  name,
  op,
  detached
}: {
  name: string;
  op: AgentGitHead['op'];
  detached: boolean;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const Icon = copied ? Check : detached ? GitCommitHorizontal : GitBranch;

  const copy = (): void => {
    void navigator.clipboard.writeText(name);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  return (
    <button
      type="button"
      onClick={copy}
      // The full name, because the one on screen may have had its middle taken
      // out, and a branch you cannot read in full is one you cannot check.
      title={`${name}${op === null ? '' : ` (${op})`} - click to copy`}
      className="flex min-w-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-fleet-text-secondary focus-ring"
    >
      <Icon size={11} className="shrink-0" />
      {/* Isolated: git accepts right-to-left characters in a ref name, and an
          unisolated one reorders the folder name sitting next to it. */}
      <bdi className={`truncate ${detached ? 'font-mono' : ''}`}>{truncateBranch(name)}</bdi>
      {op !== null && <span className="shrink-0 opacity-70">({op})</span>}
    </button>
  );
}

/** The folder itself, not the path to it - the full path is in the tooltip. */
function folderName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}
