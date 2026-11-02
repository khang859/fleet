import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import {
  stagesOf,
  type WorkflowAgentDef,
  type WorkflowDef,
  type WorkflowInput,
  type WorkflowStageDef
} from '../../../../shared/workflows';
import { AddAgentDialog } from './AddAgentDialog';
import { AgentAccessFields, ProgramField } from './agent-fields';
import { finishNote } from './stage-notes';
import { usePrograms } from './use-programs';
import { Button, Field, FIELD_CLASS, SectionTitle } from './parts';
import { AgentChips, StageColumns, type MapColumn } from './StageMap';
import { PROGRAM_LABELS, whereText } from './workflow-review';
import { inputTypeOf, workspaceOf } from './workflow-toml';
import {
  addAgent,
  addStage,
  changeAgent,
  changeStage,
  earlierRoles,
  moveAgent,
  removeAgent,
  removeStage,
  replaceAt,
  resumeTarget,
  withStages,
  type AgentAt
} from './workflow-stage-edit';

type Selected = { kind: 'start' } | { kind: 'end' } | ({ kind: 'agent' } & AgentAt);

type EditProps = { def: WorkflowDef; onChange: (def: WorkflowDef) => void };

function InputRow({
  input,
  onChange,
  onRemove
}: {
  input: WorkflowInput;
  onChange: (input: WorkflowInput) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <input
        aria-label="Label"
        className={FIELD_CLASS}
        placeholder="Label, such as Question"
        value={input.label}
        onChange={(e) => onChange({ ...input, label: e.target.value })}
      />
      <input
        aria-label="Name"
        className={`${FIELD_CLASS} w-40 font-mono`}
        placeholder="name"
        value={input.name}
        onChange={(e) => onChange({ ...input, name: e.target.value })}
      />
      <select
        aria-label="Type"
        className={`${FIELD_CLASS} w-32`}
        value={input.type}
        onChange={(e) => onChange({ ...input, type: inputTypeOf(e.target.value) })}
      >
        <option value="text">Text</option>
        <option value="pr">Pull request</option>
        <option value="issue">GitHub issue</option>
      </select>
      <button
        aria-label="Remove input"
        onClick={onRemove}
        className="rounded p-1 text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text"
      >
        <X size={13} />
      </button>
    </div>
  );
}

function StartPanel({ def, onChange }: EditProps): React.JSX.Element {
  const addInput = (): void => {
    const input: WorkflowInput = { name: '', label: '', type: 'text', required: true };
    onChange({ ...def, inputs: [...def.inputs, input] });
  };
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="space-y-3">
        <Field label="Name">
          <input
            className={FIELD_CLASS}
            value={def.name}
            onChange={(e) => onChange({ ...def, name: e.target.value })}
          />
        </Field>
        <Field label="Where agents work">
          <select
            className={FIELD_CLASS}
            value={def.workspace}
            onChange={(e) => onChange({ ...def, workspace: workspaceOf(e.target.value) })}
          >
            <option value="new-branch">New branch</option>
            <option value="pr-worktree">New worktree for each PR</option>
            <option value="current">Current folder</option>
          </select>
        </Field>
        <label className="flex items-center gap-2 text-xs text-fleet-text-secondary">
          <input
            type="checkbox"
            checked={def.board}
            onChange={(e) => onChange({ ...def, board: e.target.checked })}
          />
          Use a shared board, so agents skip repeats
        </label>
      </div>
      <div className="space-y-3">
        <Field label="Instructions for all agents">
          <textarea
            rows={3}
            className={`${FIELD_CLASS} resize-y`}
            value={def.shared}
            onChange={(e) => onChange({ ...def, shared: e.target.value })}
          />
        </Field>
        <section>
          <SectionTitle
            right={
              <Button tone="quiet" onClick={addInput}>
                <Plus size={12} /> Add input
              </Button>
            }
          >
            Fleet asks for
          </SectionTitle>
          <div className="space-y-2">
            {def.inputs.map((input, index) => (
              <InputRow
                key={index}
                input={input}
                onChange={(next) =>
                  onChange({ ...def, inputs: replaceAt(def.inputs, index, next) })
                }
                onRemove={() =>
                  onChange({ ...def, inputs: def.inputs.filter((_, at) => at !== index) })
                }
              />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function EndPanel({ def, onChange }: EditProps): React.JSX.Element {
  const action = def.finish?.action ?? 'none';
  const setAction = (value: string): void => {
    if (value === 'none') onChange({ ...def, finish: undefined });
    else if (
      value === 'open-pr' ||
      value === 'post-pr' ||
      value === 'post-issue' ||
      value === 'save-report'
    ) {
      onChange({ ...def, finish: { action: value } });
    }
  };
  return (
    <div className="max-w-md space-y-3">
      <Field label="At the end">
        <select className={FIELD_CLASS} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="open-pr">Open a pull request</option>
          <option value="post-pr">Post the report on the PR</option>
          <option value="post-issue">Post the report on the issue</option>
          <option value="save-report">Save a report file</option>
          <option value="none">Do nothing</option>
        </select>
      </Field>
      {action === 'save-report' && (
        <Field label="Save to" hint="Inside the project. It must end in .md.">
          <input
            className={`${FIELD_CLASS} font-mono`}
            placeholder="docs/research/{{slug}}.md"
            value={def.finish?.path ?? ''}
            onChange={(e) =>
              onChange({
                ...def,
                finish: { action: 'save-report', path: e.target.value || undefined }
              })
            }
          />
        </Field>
      )}
    </div>
  );
}

function ResumeField({
  stages,
  at,
  agent,
  onChange
}: {
  stages: WorkflowStageDef[];
  at: AgentAt;
  agent: WorkflowAgentDef;
  onChange: (agent: WorkflowAgentDef) => void;
}): React.JSX.Element | null {
  const roles = earlierRoles(stages, at.stage);
  if (roles.length === 0) return null;
  const pick = (role: string): void => {
    const target = resumeTarget(stages, at.stage, role);
    if (!target) onChange({ ...agent, resume: undefined });
    else onChange({ ...agent, resume: role, program: target.program });
  };
  return (
    <Field label="Goes on from" hint="It keeps that agent's session and remembers its talk.">
      <select
        className={FIELD_CLASS}
        value={agent.resume ?? ''}
        onChange={(e) => pick(e.target.value)}
      >
        <option value="">Nobody: a new session</option>
        {roles.map((role) => (
          <option key={role} value={role}>
            {role}
          </option>
        ))}
      </select>
    </Field>
  );
}

function AgentPanel({
  stages,
  at,
  onStages,
  onMove,
  onRemove
}: {
  stages: WorkflowStageDef[];
  at: AgentAt;
  onStages: (stages: WorkflowStageDef[]) => void;
  onMove: (stage: number) => void;
  onRemove: () => void;
}): React.JSX.Element {
  const agent = stages[at.stage].agents[at.agent];
  const programs = usePrograms();
  const change = (next: WorkflowAgentDef): void => onStages(changeAgent(stages, at, next));
  return (
    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)]">
      <div className="space-y-3">
        <Field label="Name">
          <input
            className={FIELD_CLASS}
            value={agent.role}
            onChange={(e) => change({ ...agent, role: e.target.value })}
          />
        </Field>
        <ProgramField
          programs={programs}
          value={agent.program}
          disabled={agent.resume !== undefined}
          hint={agent.resume ? `It uses the program of ${agent.resume}.` : undefined}
          onChange={(program) => change({ ...agent, program })}
        />
        <AgentAccessFields agent={agent} onChange={change} />
        <ResumeField stages={stages} at={at} agent={agent} onChange={change} />
        <Field label="Stage">
          <select
            className={FIELD_CLASS}
            value={at.stage}
            onChange={(e) => onMove(Number(e.target.value))}
          >
            {stages.map((stage, index) => (
              <option key={index} value={index}>
                {stage.name}
              </option>
            ))}
          </select>
        </Field>
        <Button tone="danger" onClick={onRemove}>
          Remove agent
        </Button>
      </div>
      <Field
        label="Instructions"
        hint="It also gets the shared instructions, the plan, the code on the branch and the board."
      >
        <textarea
          rows={12}
          className={`${FIELD_CLASS} resize-y leading-relaxed`}
          value={agent.prompt}
          onChange={(e) => change({ ...agent, prompt: e.target.value })}
        />
      </Field>
    </div>
  );
}

function AgentCard({
  agent,
  active,
  onPick
}: {
  agent: WorkflowAgentDef;
  active: boolean;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={`block w-full space-y-1 rounded-md border bg-fleet-surface p-2 text-left ${
        active
          ? 'border-[var(--fleet-accent)]'
          : 'border-fleet-border hover:border-fleet-border-strong'
      }`}
    >
      <span className="block truncate text-xs font-medium text-fleet-text">
        {agent.role || 'No name yet'}
      </span>
      <span className="block text-[11px] text-fleet-text-subtle">
        {PROGRAM_LABELS[agent.program]}
      </span>
      <AgentChips agent={agent} />
    </button>
  );
}

function FixedCard({
  text,
  active,
  onPick
}: {
  text: string;
  active: boolean;
  onPick: () => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onPick}
      className={`block w-full rounded-md border bg-fleet-surface p-2 text-left text-[11px] text-fleet-text-secondary ${
        active
          ? 'border-[var(--fleet-accent)]'
          : 'border-fleet-border hover:border-fleet-border-strong'
      }`}
    >
      {text}
    </button>
  );
}

function StageTitle({
  stage,
  canRemove,
  onName,
  onRemove
}: {
  stage: WorkflowStageDef;
  canRemove: boolean;
  onName: (name: string) => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <input
        aria-label="Stage name"
        className="min-w-0 flex-1 bg-transparent text-xs font-semibold text-fleet-text focus:outline-none"
        value={stage.name}
        onChange={(e) => onName(e.target.value)}
      />
      {canRemove && (
        <button
          aria-label={`Remove stage ${stage.name}`}
          onClick={onRemove}
          className="rounded p-0.5 text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text"
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

function stageNote(stage: WorkflowStageDef, index: number): string {
  if (stage.only_with_findings) return 'Skipped when the board is empty';
  if (index === 0) return 'Runs first';
  return stage.agents.length > 1 ? 'They run at the same time' : 'Runs after the stage before';
}

/** The map, with a panel under it for the card a person picked. */
export function StageEditor({
  def,
  projectPath,
  onChange
}: EditProps & { projectPath: string }): React.JSX.Element {
  const [selected, setSelected] = useState<Selected>({ kind: 'start' });
  const [addingTo, setAddingTo] = useState<number | null>(null);
  const stages = stagesOf(def);
  const onStages = (next: WorkflowStageDef[]): void => onChange(withStages(def, next));

  const pickNewAgent = (stage: number, agent: WorkflowAgentDef): void => {
    onStages(addAgent(stages, stage, agent));
    setSelected({ kind: 'agent', stage, agent: stages[stage].agents.length });
    setAddingTo(null);
  };

  const dropStage = (index: number): void => {
    setSelected({ kind: 'start' });
    onStages(removeStage(stages, index));
  };

  const stageColumn = (stage: WorkflowStageDef, index: number): MapColumn => ({
    key: `stage-${index}`,
    title: (
      <StageTitle
        stage={stage}
        canRemove={stages.length > 1}
        onName={(name) => onStages(changeStage(stages, index, { name }))}
        onRemove={() => dropStage(index)}
      />
    ),
    note: stageNote(stage, index),
    children: (
      <>
        {stage.agents.map((agent, at) => (
          <AgentCard
            key={at}
            agent={agent}
            active={selected.kind === 'agent' && selected.stage === index && selected.agent === at}
            onPick={() => setSelected({ kind: 'agent', stage: index, agent: at })}
          />
        ))}
        <button
          type="button"
          onClick={() => setAddingTo(index)}
          className="rounded-md border border-dashed border-fleet-border-strong py-1.5 text-xs font-medium text-fleet-text-subtle hover:text-fleet-text"
        >
          Add agent here
        </button>
        {index > 0 && def.board && (
          <label className="flex items-center gap-1.5 text-[11px] text-fleet-text-subtle">
            <input
              type="checkbox"
              checked={stage.only_with_findings === true}
              onChange={(e) =>
                onStages(
                  changeStage(stages, index, { only_with_findings: e.target.checked || undefined })
                )
              }
            />
            Only with findings
          </label>
        )}
      </>
    )
  });

  const columns: MapColumn[] = [
    {
      key: 'start',
      title: 'Start',
      note: whereText(def),
      quiet: true,
      children: (
        <FixedCard
          text={`${def.inputs.length === 1 ? '1 input' : `${def.inputs.length} inputs`}. Name and setup.`}
          active={selected.kind === 'start'}
          onPick={() => setSelected({ kind: 'start' })}
        />
      )
    },
    ...stages.map(stageColumn),
    {
      key: 'end',
      title: 'End',
      note: finishNote(def),
      quiet: true,
      children: (
        <FixedCard
          text="What happens at the end."
          active={selected.kind === 'end'}
          onPick={() => setSelected({ kind: 'end' })}
        />
      )
    }
  ];

  return (
    <div className="space-y-4">
      <StageColumns
        columns={columns}
        between={(index) =>
          index < stages.length + 1 ? (
            <button
              aria-label="Add a stage here"
              onClick={() => onStages(addStage(stages, index))}
              className="flex h-5 w-5 items-center justify-center rounded border border-fleet-border-strong text-fleet-text-secondary hover:bg-fleet-surface-2"
            >
              <Plus size={11} />
            </button>
          ) : null
        }
      />
      <div className="rounded-md border border-fleet-border p-4">
        {selected.kind === 'start' && <StartPanel def={def} onChange={onChange} />}
        {selected.kind === 'end' && <EndPanel def={def} onChange={onChange} />}
        {selected.kind === 'agent' && (
          <AgentPanel
            stages={stages}
            at={selected}
            onStages={onStages}
            onMove={(stage) => {
              onStages(moveAgent(stages, selected, stage));
              setSelected({ kind: 'agent', stage, agent: stages[stage].agents.length });
            }}
            onRemove={() => {
              onStages(removeAgent(stages, selected));
              setSelected({ kind: 'start' });
            }}
          />
        )}
      </div>
      <AddAgentDialog
        open={addingTo !== null}
        projectPath={projectPath}
        stage={addingTo === null ? null : stages[addingTo]}
        onAdd={(agent) => addingTo !== null && pickNewAgent(addingTo, agent)}
        onClose={() => setAddingTo(null)}
      />
    </div>
  );
}
