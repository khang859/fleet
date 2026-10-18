import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { ChevronDown, Plus, Settings2 } from 'lucide-react';
import type { AgencyRepoRef } from '../../../../shared/agency';
import { popperAnim } from '../../lib/motion';
import { switchToProject, useAdmiralOnboardingStore } from '../../store/admiral-onboarding-store';
import { projectStatus } from './onboarding-view';

/**
 * The header's project chip: the projects the Admiral knows, each in its own
 * Admiral tab. Picking one brings that tab forward, or opens it; "Add a
 * project" turns this pane to the picker, and "Set up again" to the pane's
 * project setup, for a member added or a finding changed since.
 */
export function ProjectSwitcher({
  paneId,
  repo
}: {
  paneId: string;
  repo: AgencyRepoRef;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const projects = useAdmiralOnboardingStore((s) => s.projects);
  const loadProjects = useAdmiralOnboardingStore((s) => s.loadProjects);
  const setPicking = useAdmiralOnboardingStore((s) => s.setPicking);
  const setRedoingSetup = useAdmiralOnboardingStore((s) => s.setRedoingSetup);

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void loadProjects();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          title={repo.root}
          aria-label={`Project: ${repo.name}. Switch project`}
          className={`flex max-w-[180px] shrink-0 items-center gap-1 rounded border px-1.5 py-px font-mono text-[11px] transition-colors focus-ring ${
            open
              ? 'border-fleet-border-strong bg-fleet-surface-2 text-fleet-text'
              : 'border-transparent bg-fleet-surface-2 text-fleet-text-muted hover:text-fleet-text'
          }`}
        >
          <span className="truncate">{repo.name}</span>
          <ChevronDown size={11} className="shrink-0" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side="bottom"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          className={`z-50 w-[340px] max-w-[calc(100vw-16px)] rounded-lg border border-fleet-border-strong bg-fleet-surface p-1.5 shadow-xl ${popperAnim}`}
        >
          <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-fleet-text-muted">
            Your projects
          </div>
          <div className="flex max-h-[300px] flex-col overflow-y-auto">
            {projects.map((p) => {
              const current = p.repo.repoId === repo.repoId;
              return (
                <button
                  key={p.repo.repoId}
                  type="button"
                  aria-current={current}
                  title={p.repo.root}
                  onClick={() => {
                    setOpen(false);
                    if (!current) void switchToProject(p.repo);
                  }}
                  className={`flex items-center gap-3 rounded-md px-2 py-2 text-left transition-colors focus-ring ${
                    current ? 'bg-fleet-surface-2' : 'hover:bg-fleet-surface-2'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fleet-text">
                    {p.repo.name}
                  </span>
                  <span
                    className={`shrink-0 text-[11px] ${
                      p.openQuestions > 0
                        ? 'text-amber-600 dark:text-amber-400'
                        : 'text-fleet-text-muted'
                    }`}
                  >
                    {projectStatus(p)}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="my-1.5 h-px bg-fleet-border" />
          <MenuAction
            icon={<Plus size={14} className="shrink-0" />}
            onClick={() => {
              setOpen(false);
              setPicking(paneId, true);
            }}
          >
            Add a project
          </MenuAction>
          <MenuAction
            icon={<Settings2 size={14} className="shrink-0" />}
            onClick={() => {
              setOpen(false);
              setRedoingSetup(paneId, true);
            }}
          >
            Set up {repo.name} again
          </MenuAction>
          <p className="px-2 pt-1 pb-1 text-[11px] text-fleet-text-subtle">
            Each project opens its own Admiral tab.
          </p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function MenuAction({
  icon,
  onClick,
  children
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[13px] text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text focus-ring"
    >
      {icon}
      <span className="truncate">{children}</span>
    </button>
  );
}
