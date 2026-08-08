import { useEffect, useState } from 'react';
import { CloudDownload, Download, FolderOpen, Trash2 } from 'lucide-react';
import type { InstalledSkill } from '../../../../../../shared/agent-skill-install';
import { FieldGroup } from '../primitives';
import { MenuItem, RowMenu } from '../RowMenu';
import { newlyFound, useAgentSkillsStore } from '../../../../store/agent-skills-store';
import { useWorkspaceStore } from '../../../../store/workspace-store';
import { SkillImportDialog } from './SkillImportDialog';
import { SkillFetchDialog } from './SkillFetchDialog';

/**
 * The skills the agent may use.
 *
 * A list of names and descriptions, because that is exactly what the agent
 * sees: a skill costs one line in the tool roster until the model asks for it,
 * and the description is the whole of what it decides on. Showing the user the
 * same line is showing them the thing that actually matters.
 */
export function SkillsSection(): React.JSX.Element {
  const { installed, loaded, detected, scanning, installErrors } = useAgentSkillsStore();
  const store = useAgentSkillsStore;
  const recentFolders = useWorkspaceStore((s) => s.recentFolders);
  const [importing, setImporting] = useState(false);
  const [fetching, setFetching] = useState(false);

  // The project scope of a scan needs a folder, and the settings pane is not
  // opened in one. The folder the user was last working in is the closest thing
  // this pane can honestly name, and the import dialog shows the path of every
  // root it read, so the guess is never silent.
  const cwd = recentFolders[0] ?? window.fleet.homeDir;

  useEffect(() => {
    void store.getState().load();
    // Scanned unprompted so the Import button can say there is something to
    // import. A user who has to press Import to find out whether pressing
    // Import is worth it will not press it.
    void store.getState().scan(cwd);
  }, [store, cwd]);

  return (
    <FieldGroup title="Skills">
      {installed.length === 0 ? (
        <div className="rounded-lg border border-dashed border-fleet-border-strong px-4 py-6 text-center">
          <p className="text-sm text-fleet-text-secondary">No skills installed.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-fleet-text-muted">
            {loaded
              ? 'A skill is a folder of instructions the agent reads when it needs them - a house style, a release checklist, how to drive one awkward tool.'
              : 'Loading…'}
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {installed.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              onReveal={() => void store.getState().reveal(skill.path)}
              onRemove={() => void store.getState().remove(skill.name)}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setImporting(true)}
          className="flex items-center gap-1.5 rounded-md border border-fleet-border-strong px-2.5 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
        >
          <Download size={13} />
          Import
          {newlyFound(detected) > 0 && (
            <span className="rounded-full fleet-accent-bg px-1.5 text-[10px] font-medium text-white">
              {newlyFound(detected)}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => setFetching(true)}
          className="flex items-center gap-1.5 rounded-md border border-fleet-border-strong px-2.5 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
        >
          <CloudDownload size={13} />
          From a repository
        </button>
      </div>

      {installErrors.length > 0 && (
        <div className="space-y-0.5">
          {installErrors.map((failure) => (
            <p key={failure.name} className="text-xs text-amber-400">
              {failure.name} was not installed - {failure.reason}.
            </p>
          ))}
        </div>
      )}

      <SkillImportDialog
        open={importing}
        found={detected}
        scanning={scanning}
        onCancel={() => setImporting(false)}
        onImport={(picked) => {
          setImporting(false);
          void store.getState().install(picked, cwd);
        }}
      />

      <SkillFetchDialog
        open={fetching}
        onClose={() => setFetching(false)}
        onInstall={(picked) => {
          setFetching(false);
          void store
            .getState()
            .install(picked, cwd)
            // The checkout has served its purpose once the copies are made.
            .then(async () => store.getState().discard());
        }}
      />
    </FieldGroup>
  );
}

function SkillRow({
  skill,
  onReveal,
  onRemove
}: {
  skill: InstalledSkill;
  onReveal: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-fleet-border px-3 py-2 transition-colors hover:bg-fleet-surface-2/50">
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-xs text-fleet-text">{skill.name}</p>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fleet-text-muted">
          {skill.description}
        </p>
      </div>
      <RowMenu label={skill.name}>
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
