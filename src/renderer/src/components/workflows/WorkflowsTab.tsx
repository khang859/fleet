import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, FolderOpen } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import type { WorkflowProject } from '../../../../shared/workflows';
import {
  showWorkflowError,
  useWorkflowsStore,
  type WorkflowsView
} from '../../store/workflows-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { popperAnim } from '../../lib/motion';
import { AutomaticView } from './AutomaticView';
import { Button } from './parts';
import { RunsView } from './RunsView';
import { WorkflowsView as WorkflowsListView } from './WorkflowsView';

const VIEWS: Array<{ id: WorkflowsView; label: string }> = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'runs', label: 'Runs' },
  { id: 'automatic', label: 'Automatic' }
];

function ProjectMenu(): React.JSX.Element {
  const projects = useWorkflowsStore((s) => s.projects);
  const projectPath = useWorkflowsStore((s) => s.projectPath);
  const setProject = useWorkflowsStore((s) => s.setProject);
  const addProject = useWorkflowsStore((s) => s.addProject);
  const [open, setOpen] = useState(false);
  const current = projects.find((project) => project.path === projectPath);

  const pick = (project: WorkflowProject): void => {
    setOpen(false);
    setProject(project.path).catch(showWorkflowError);
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button className="flex items-center gap-1.5 rounded px-2 py-1 text-xs font-medium text-fleet-text hover:bg-fleet-surface-2">
          {current?.name ?? 'Pick a project'}
          <ChevronDown size={12} className="text-fleet-text-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={4}
          className={`z-50 w-64 rounded-md border border-fleet-border-strong bg-fleet-surface p-1 shadow-lg shadow-black/30 ${popperAnim}`}
        >
          {projects.map((project) => (
            <button
              key={project.path}
              onClick={() => pick(project)}
              className={`block w-full rounded px-2 py-1.5 text-left hover:bg-fleet-surface-2 ${
                project.path === projectPath ? 'bg-fleet-surface-2' : ''
              }`}
            >
              <span className="block text-xs text-fleet-text">{project.name}</span>
              <span className="block truncate text-[11px] text-fleet-text-subtle">
                {project.path}
              </span>
            </button>
          ))}
          <div className="my-1 border-t border-fleet-border" />
          <button
            onClick={() => {
              setOpen(false);
              addProject().catch(showWorkflowError);
            }}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-fleet-text-secondary hover:bg-fleet-surface-2"
          >
            <FolderOpen size={13} /> Open another folder
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The folders of what is open, one per line, so the value only changes when they do. */
function useOpenFolders(): string {
  const tabs = useWorkspaceStore((s) => s.workspace.tabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  return useMemo(() => {
    const normal = tabs.filter(
      (tab) => !tab.workflowRunId && (tab.type ?? 'terminal') === 'terminal'
    );
    const active = normal.find((tab) => tab.id === activeTabId);
    const folders = [...(active ? [active.cwd] : []), ...normal.map((tab) => tab.cwd)];
    return [...new Set(folders)].join('\n');
  }, [tabs, activeTabId]);
}

export function WorkflowsTab(): React.JSX.Element {
  const view = useWorkflowsStore((s) => s.view);
  const setView = useWorkflowsStore((s) => s.setView);
  const projectPath = useWorkflowsStore((s) => s.projectPath);
  const loadProjects = useWorkflowsStore((s) => s.loadProjects);
  const addProject = useWorkflowsStore((s) => s.addProject);
  const folders = useOpenFolders();

  useEffect(() => {
    loadProjects(folders.split('\n').filter(Boolean)).catch(showWorkflowError);
  }, [folders, loadProjects]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-shrink-0 items-center gap-1 border-b border-fleet-border px-3 py-1.5">
        <ProjectMenu />
        <div className="mx-1 h-4 w-px bg-fleet-border" />
        {VIEWS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setView(id)}
            className={`rounded px-2.5 py-1 text-xs font-medium ${
              view === id
                ? 'bg-fleet-surface-2 text-fleet-text'
                : 'text-fleet-text-subtle hover:bg-fleet-surface-2/50'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!projectPath ? (
          <div className="py-16 text-center">
            <p className="pb-3 text-xs text-fleet-text-subtle">
              Pick a project to see its workflows.
            </p>
            <Button onClick={addProject}>
              <FolderOpen size={13} /> Open a folder
            </Button>
          </div>
        ) : view === 'workflows' ? (
          <WorkflowsListView key={projectPath} projectPath={projectPath} />
        ) : view === 'runs' ? (
          <RunsView key={projectPath} projectPath={projectPath} />
        ) : (
          <AutomaticView key={projectPath} projectPath={projectPath} />
        )}
      </div>
    </div>
  );
}
