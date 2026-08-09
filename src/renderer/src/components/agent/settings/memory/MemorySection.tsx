import { useEffect } from 'react';
import { FolderOpen, Trash2 } from 'lucide-react';
import type { MemoryDescriptor } from '../../../../../../shared/agent-memory';
import { FieldGroup } from '../primitives';
import { MenuItem, RowMenu } from '../RowMenu';
import { useAgentMemoryStore } from '../../../../store/agent-memory-store';

/**
 * What earlier sessions wrote down.
 *
 * `SkillsSection` without the two buttons, and the absence is the design. There
 * is nothing to import - memory is Fleet's own format with no ecosystem behind
 * it - and nothing to add, because the agent is what writes these.
 *
 * What the row shows is what the model sees before it decides to read one: a
 * name and one line. The badge is the extra, because which tier an entry is in
 * decides who else reads it - a project entry sits inside the repository and
 * travels to everyone who clones it.
 *
 * Remove is the undo. There is no revision history behind it: a create is fully
 * undone by deleting the file, and an overwrite left its diff in the transcript
 * of the turn that made it.
 *
 * `cwd` is the pane's own folder rather than `SkillsSection`'s guess at a recent
 * one, because the project tier lives inside a repository: a list read against
 * the wrong folder would be missing entries with nothing to say it was.
 */
export function MemorySection({ cwd }: { cwd: string }): React.JSX.Element {
  const { entries, loaded } = useAgentMemoryStore();
  const store = useAgentMemoryStore;

  useEffect(() => {
    void store.getState().load(cwd);
  }, [store, cwd]);

  return (
    <FieldGroup title="Memory">
      {entries.length === 0 ? (
        <div className="rounded-lg border border-dashed border-fleet-border-strong px-4 py-6 text-center">
          <p className="text-sm text-fleet-text-secondary">Nothing recorded yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-fleet-text-muted">
            {loaded
              ? 'The agent writes a note here when a session teaches it something the next one would otherwise work out again. Run /refine to ask it to look back over a conversation.'
              : 'Loading…'}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {entries.map((entry) => (
            <MemoryRow
              key={`${entry.source}/${entry.name}`}
              entry={entry}
              onReveal={() => void store.getState().reveal(entry.path)}
              onRemove={() => void store.getState().remove(entry.source, entry.name)}
            />
          ))}
        </div>
      )}
    </FieldGroup>
  );
}

function MemoryRow({
  entry,
  onReveal,
  onRemove
}: {
  entry: MemoryDescriptor;
  onReveal: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-fleet-border px-3 py-2 transition-colors hover:bg-fleet-surface-2/50">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate font-mono text-xs text-fleet-text">{entry.name}</p>
          <span className="shrink-0 rounded border border-fleet-border-strong px-1.5 py-px text-[10px] leading-tight text-fleet-text-muted">
            {entry.source === 'project' ? 'This project' : 'Everywhere'}
          </span>
        </div>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fleet-text-muted">
          {entry.description}
        </p>
      </div>
      <RowMenu label={entry.name}>
        {(pick) => (
          <>
            <MenuItem icon={<FolderOpen size={13} />} onClick={pick(onReveal)}>
              Show in Finder
            </MenuItem>
            <MenuItem icon={<Trash2 size={13} />} danger onClick={pick(onRemove)}>
              Remove
            </MenuItem>
          </>
        )}
      </RowMenu>
    </div>
  );
}
