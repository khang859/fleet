import { useEffect, useState } from 'react';
import { Download, Loader2 } from 'lucide-react';
import type { FoundSkill } from '../../../../../../shared/agent-skill-install';
import { Overlay } from '../../../Overlay';
import { defaultPicks } from '../../../../store/agent-skills-store';
import { SkillPickList } from './SkillPickList';

/**
 * The skills already on this machine, offered as a list to tick.
 *
 * `SKILL.md` is a shared format, so most users who want this feature already
 * have skills sitting in a folder Fleet cannot see. This is the half of the
 * feature that pays for itself before anyone types a repository name.
 */
export function SkillImportDialog({
  open,
  found,
  scanning,
  onCancel,
  onImport
}: {
  open: boolean;
  found: FoundSkill[];
  scanning: boolean;
  onCancel: () => void;
  onImport: (picked: Array<{ name: string; path: string }>) => void;
}): React.JSX.Element {
  const [picked, setPicked] = useState<Set<string>>(new Set());

  // Everything not already held starts ticked: the common case is "yes, all of
  // them", and a user who wants three of eight unticks five faster than they
  // tick three.
  useEffect(() => {
    if (!open) return;
    setPicked(defaultPicks(found));
  }, [open, found]);

  const chosen = found.filter((f) => picked.has(f.origin.path));

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      panelClassName="w-[600px] h-[min(70vh,560px)] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <Download size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">Import skills</h2>
          <p className="text-xs text-fleet-text-muted">
            Fleet copies the whole folder, so editing one here changes nothing over there.
          </p>
        </div>
      </div>

      <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto border-t border-fleet-border">
        {scanning ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-fleet-text-muted">
            <Loader2 size={15} className="animate-spin" />
            Looking for skills…
          </div>
        ) : found.length === 0 ? (
          <div className="px-5 py-16 text-center">
            <p className="text-sm text-fleet-text-muted">No skills found on this machine.</p>
            <p className="mt-1 text-xs text-fleet-text-subtle">
              Fleet looks in Claude Code, OpenCode and <code>~/.agents</code>, for the user and for
              this project.
            </p>
          </div>
        ) : (
          <SkillPickList found={found} picked={picked} onPickedChange={setPicked} />
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-fleet-border px-5 py-3">
        <span className="text-[11px] text-fleet-text-subtle">
          Scripts and reference files come across too.
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 focus-ring"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={chosen.length === 0}
            onClick={() => onImport(chosen.map((f) => ({ name: f.name, path: f.origin.path })))}
            className="rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] disabled:opacity-40 focus-ring-offset"
          >
            {chosen.length === 1 ? 'Import 1 skill' : `Import ${chosen.length} skills`}
          </button>
        </div>
      </div>
    </Overlay>
  );
}
