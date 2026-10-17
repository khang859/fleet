import { useEffect, useState } from 'react';
import { FolderDown } from 'lucide-react';
import { Overlay } from '../Overlay';
import { quotePathForShell } from '../../lib/shell-utils';
import { useWorkspaceStore } from '../../store/workspace-store';
import { OnboardingButton, textInputCls } from './onboarding-ui';
import { cloneSlug, homePath } from './onboarding-view';

/**
 * "Clone from GitHub": `gh repo clone` into a folder the client picks, run in
 * a terminal tab so its progress, a sign-in prompt or an error is in plain
 * sight. The picker shows the new repository once the clone is there.
 */
export function CloneDialog({
  open,
  onClose,
  onStarted
}: {
  open: boolean;
  onClose: () => void;
  /** The folder the clone goes into, so the picker can look for it. */
  onStarted: (dest: string) => void;
}): React.JSX.Element {
  const home = window.fleet.homeDir;
  const [repo, setRepo] = useState('');
  const [parent, setParent] = useState(home);

  useEffect(() => {
    if (!open) return;
    setRepo('');
    setParent(home);
  }, [open, home]);

  const slug = cloneSlug(repo);
  const dest = slug === null ? null : `${parent.replace(/\/$/, '')}/${slug.split('/')[1]}`;

  const choose = async (): Promise<void> => {
    const picked = await window.fleet.showFolderPicker();
    if (picked !== null) setParent(picked);
  };

  const start = (): void => {
    if (slug === null || dest === null) return;
    const cmd = `gh repo clone ${quotePathForShell(slug, 'posix')} ${quotePathForShell(dest, 'posix')}`;
    useWorkspaceStore.getState().openResumeTab(parent, cmd, `Clone ${slug.split('/')[1]}`);
    onStarted(dest);
    onClose();
  };

  return (
    <Overlay open={open} onClose={onClose}>
      <form
        role="dialog"
        aria-labelledby="admiral-clone-title"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
        className="flex w-[440px] max-w-[calc(100vw-32px)] flex-col gap-3 rounded-lg border border-fleet-border-strong bg-fleet-surface-2 p-4 shadow-xl"
      >
        <div className="flex items-center gap-2">
          <FolderDown size={15} className="text-fleet-text-muted" />
          <h3 id="admiral-clone-title" className="text-sm font-semibold text-fleet-text">
            Clone from GitHub
          </h3>
        </div>
        <label className="flex flex-col gap-1 text-xs text-fleet-text-muted">
          Repository
          <input
            autoFocus
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder="owner/name or a GitHub URL"
            spellCheck={false}
            className={`${textInputCls} font-mono`}
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-fleet-text-muted">
          Into
          <div className="flex gap-2">
            <span
              title={parent}
              className={`${textInputCls} flex-1 truncate font-mono text-fleet-text-secondary`}
            >
              {homePath(parent, home)}
            </span>
            <OnboardingButton onClick={() => void choose()}>Choose…</OnboardingButton>
          </div>
        </div>
        <p className="min-h-4 text-[11px] text-fleet-text-subtle">
          {dest === null
            ? 'Runs gh repo clone in a terminal tab, signed in as you.'
            : `Clones to ${homePath(dest, home)} in a terminal tab.`}
        </p>
        <div className="flex justify-end gap-2">
          <OnboardingButton kind="ghost" onClick={onClose}>
            Cancel
          </OnboardingButton>
          <OnboardingButton type="submit" kind="primary" disabled={slug === null}>
            Clone
          </OnboardingButton>
        </div>
      </form>
    </Overlay>
  );
}
