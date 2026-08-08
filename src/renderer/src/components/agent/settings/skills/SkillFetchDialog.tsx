import { useEffect, useState } from 'react';
import { CloudDownload, Loader2, TriangleAlert } from 'lucide-react';
import { toCloneUrl } from '../../../../../../shared/agent-skill-install';
import { Overlay } from '../../../Overlay';
import { defaultPicks, useAgentSkillsStore } from '../../../../store/agent-skills-store';
import { SkillPickList } from './SkillPickList';

/**
 * Getting skills from a repository.
 *
 * A clone rather than a package install, because that is how skills are
 * actually published - `anthropics/skills` and the community collections are
 * repositories people clone, not packages anybody registers. Nothing is kept
 * from the checkout except the folders the user ticks; the rest is thrown away
 * when this closes.
 */
export function SkillFetchDialog({
  open,
  onClose,
  onInstall
}: {
  open: boolean;
  onClose: () => void;
  onInstall: (picked: Array<{ name: string; path: string }>) => void;
}): React.JSX.Element {
  const { fetched, fetching, fetchError } = useAgentSkillsStore();
  const store = useAgentSkillsStore;
  const [from, setFrom] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setFrom('');
    setPicked(new Set());
  }, [open]);

  // Whatever came back starts ticked, the same way the import dialog does it.
  useEffect(() => {
    if (fetched === null) return;
    setPicked(defaultPicks(fetched.found));
  }, [fetched]);

  const url = toCloneUrl(from);
  const chosen = fetched === null ? [] : fetched.found.filter((f) => picked.has(f.origin.path));

  const close = (): void => {
    // The checkout is a temporary directory in main. Leaving without discarding
    // it would leave it there until the app quits.
    void store.getState().discard();
    onClose();
  };

  return (
    <Overlay
      open={open}
      onClose={close}
      panelClassName="w-[600px] h-[min(70vh,560px)] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <CloudDownload size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">Get skills from a repository</h2>
          <p className="text-xs text-fleet-text-muted">
            Fleet clones it, shows what is inside, and keeps only what you pick.
          </p>
        </div>
      </div>

      <form
        className="flex items-center gap-2 px-5 pb-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (url !== null && !fetching) void store.getState().fetch(from.trim());
        }}
      >
        <input
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          autoFocus
          spellCheck={false}
          placeholder="anthropics/skills"
          className="min-w-0 flex-1 rounded-md border border-fleet-border-strong bg-fleet-surface-2 px-2.5 py-1.5 font-mono text-xs text-fleet-text placeholder:text-fleet-text-subtle focus-ring"
        />
        <button
          type="submit"
          disabled={url === null || fetching}
          className="shrink-0 rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-40 focus-ring-offset"
        >
          {fetching ? 'Cloning…' : 'Clone'}
        </button>
      </form>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto border-t border-fleet-border">
        {fetching ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-fleet-text-muted">
            <Loader2 size={15} className="animate-spin" />
            Cloning {from.trim()}…
          </div>
        ) : fetchError !== null ? (
          <div className="px-5 py-16 text-center">
            <TriangleAlert size={17} className="mx-auto mb-2 text-amber-400" />
            <p className="mx-auto max-w-sm text-sm text-fleet-text-muted">{fetchError}</p>
          </div>
        ) : fetched === null ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-fleet-text-muted">
              A repository with <code>SKILL.md</code> folders in it.
            </p>
            <p className="mt-1 text-xs text-fleet-text-subtle">
              <code>owner/repo</code>, an https URL, or an ssh one.
            </p>
          </div>
        ) : (
          <SkillPickList
            found={fetched.found}
            picked={picked}
            onPickedChange={setPicked}
            within={fetched.dir}
          />
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-fleet-border px-5 py-3">
        <button
          type="button"
          onClick={close}
          className="rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 focus-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={chosen.length === 0}
          onClick={() => onInstall(chosen.map((f) => ({ name: f.name, path: f.origin.path })))}
          className="rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-40 focus-ring-offset"
        >
          {chosen.length === 1 ? 'Install 1 skill' : `Install ${chosen.length} skills`}
        </button>
      </div>
    </Overlay>
  );
}
