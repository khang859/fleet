import { useState } from 'react';
import { Check, GitBranch, GitCommitHorizontal } from 'lucide-react';
import { headName, truncateBranch, type AgentGitHead } from '../../../../shared/agent-git';

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
  head
}: {
  cwd: string;
  head: AgentGitHead | null;
}): React.JSX.Element {
  const name = head === null ? null : headName(head);
  const detached = head !== null && head.branch === null;

  return (
    // `px-4` to share the composer's left edge exactly, so the folder name
    // lines up with the box above it rather than sitting just inside it.
    <div className="mx-auto flex w-full max-w-2xl shrink-0 items-center gap-2 px-4 pb-3 text-[11px] text-fleet-text-subtle">
      <span className="min-w-0 shrink truncate" title={cwd}>
        {folderName(cwd)}
      </span>
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
