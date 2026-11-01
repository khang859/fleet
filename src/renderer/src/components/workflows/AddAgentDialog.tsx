import { useEffect, useState } from 'react';
import { WORKFLOW_JOBS, type WorkflowJob } from '../../../../shared/workflow-jobs';
import type {
  SavedAgent,
  WorkflowAgentDef,
  WorkflowProgram,
  WorkflowStageDef
} from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError } from '../../store/workflows-store';
import { Overlay } from '../Overlay';
import { Button, Field, FIELD_CLASS } from './parts';
import { PROGRAM_LABELS } from './workflow-review';
import { hasTwoWriters } from './workflow-stage-edit';
import { AgentAccessFields, ProgramField } from './agent-fields';
import { usePrograms } from './use-programs';

function jobOfSaved(agent: SavedAgent): WorkflowJob {
  return {
    id: `saved-${agent.name}`,
    label: agent.name,
    description: agent.description,
    role: agent.name,
    access: agent.access,
    prompt: agent.prompt
  };
}

function firstInstalled(programs: Record<WorkflowProgram, boolean>): WorkflowProgram {
  return programs.claude && !programs.pi ? 'claude' : 'pi';
}

function agentOfJob(job: WorkflowJob, program: WorkflowProgram): WorkflowAgentDef {
  const { role, access, talks, plan, prompt } = job;
  return { role, program: job.program ?? program, access, talks, plan, prompt };
}

function JobRow({
  job,
  active,
  onPick
}: {
  job: WorkflowJob;
  active: boolean;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={`block w-full rounded px-2 py-1.5 text-left hover:bg-fleet-surface-2 ${
        active ? 'bg-fleet-surface-2' : ''
      }`}
    >
      <span className="block text-xs text-fleet-text">{job.label}</span>
      <span className="line-clamp-2 block text-[11px] text-fleet-text-subtle">
        {job.description}
      </span>
    </button>
  );
}

function JobList({
  title,
  jobs,
  picked,
  onPick
}: {
  title: string;
  jobs: WorkflowJob[];
  picked: string;
  onPick: (job: WorkflowJob) => void;
}): React.JSX.Element | null {
  if (jobs.length === 0) return null;
  return (
    <div className="space-y-0.5">
      <p className="px-2 pb-1 text-[11px] font-medium text-fleet-text-muted">{title}</p>
      {jobs.map((job) => (
        <JobRow key={job.id} job={job} active={job.id === picked} onPick={() => onPick(job)} />
      ))}
    </div>
  );
}

function useSavedJobs(projectPath: string, open: boolean): WorkflowJob[] {
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);

  useEffect(() => {
    if (!open) return;
    callWorkflows('savedAgents', projectPath)
      .then((saved) => setJobs(saved.map(jobOfSaved)))
      .catch(showWorkflowError);
  }, [projectPath, open]);

  return jobs;
}

/** Pick a job on the left, and see the filled fields on the right. A job copies its text. */
export function AddAgentDialog({
  open,
  projectPath,
  stage,
  onAdd,
  onClose
}: {
  open: boolean;
  projectPath: string;
  stage: WorkflowStageDef | null;
  onAdd: (agent: WorkflowAgentDef) => void;
  onClose: () => void;
}): React.JSX.Element {
  const programs = usePrograms(open);
  const saved = useSavedJobs(projectPath, open);
  const [picked, setPicked] = useState('lead');
  const [agent, setAgent] = useState(agentOfJob(WORKFLOW_JOBS[0], 'claude'));

  const pick = (job: WorkflowJob): void => {
    setPicked(job.id);
    setAgent(agentOfJob(job, job.plan ? 'claude' : firstInstalled(programs)));
  };

  const twoWriters = stage !== null && hasTwoWriters([...stage.agents, agent]);
  const canAdd = agent.role.trim() !== '' && agent.prompt.trim() !== '';

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="flex h-[32rem] max-h-[85vh] w-[46rem] max-w-[calc(100vw-2rem)] flex-col rounded-lg border border-fleet-border-strong bg-fleet-surface"
    >
      <header className="border-b border-fleet-border px-4 py-2.5">
        <h3 className="text-xs font-medium text-fleet-text">
          Add an agent to {stage?.name ?? 'this stage'}
        </h3>
      </header>
      <div className="flex min-h-0 flex-1">
        <div className="w-56 flex-shrink-0 space-y-3 overflow-y-auto border-r border-fleet-border p-2">
          <JobList title="Jobs" jobs={WORKFLOW_JOBS} picked={picked} onPick={pick} />
          <JobList title="Your saved agents" jobs={saved} picked={picked} onPick={pick} />
        </div>
        <div className="min-w-0 flex-1 space-y-3 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <input
                className={FIELD_CLASS}
                value={agent.role}
                onChange={(e) => setAgent({ ...agent, role: e.target.value })}
              />
            </Field>
            <ProgramField
              programs={programs}
              value={agent.program}
              onChange={(program) => setAgent({ ...agent, program })}
            />
          </div>
          <AgentAccessFields agent={agent} onChange={setAgent} />
          {twoWriters && (
            <p className="rounded border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-200">
              Two agents in this stage can change code at the same time. They share one folder, so
              they can undo the work of each other.
            </p>
          )}
          <Field label="Instructions">
            <textarea
              rows={7}
              className={`${FIELD_CLASS} resize-y`}
              value={agent.prompt}
              onChange={(e) => setAgent({ ...agent, prompt: e.target.value })}
            />
          </Field>
          <p className="text-[11px] text-fleet-text-subtle">
            Fleet copies this text into the file, so a person approves what will run.
          </p>
        </div>
      </div>
      <footer className="flex items-center justify-between gap-2 border-t border-fleet-border px-4 py-2.5">
        <span className="text-[11px] text-fleet-text-subtle">
          {PROGRAM_LABELS[agent.program]} runs in its own pane.
        </span>
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button tone="primary" disabled={!canAdd} onClick={() => onAdd(agent)}>
            Add agent
          </Button>
        </div>
      </footer>
    </Overlay>
  );
}
