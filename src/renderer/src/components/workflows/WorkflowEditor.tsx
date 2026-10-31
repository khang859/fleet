import { useState } from 'react';
import { Plus, X } from 'lucide-react';
import type {
  WorkflowAgentDef,
  WorkflowDef,
  WorkflowInput,
  WorkflowScope
} from '../../../../shared/workflows';
import { workspaceSlug } from '../../../../shared/claude-config';
import { callWorkflows } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Button, Field, FIELD_CLASS, SectionTitle } from './parts';
import { formToToml, parseToForm } from './workflow-toml';

export type EditorSource = {
  text: string;
  fileName: string;
  scope: WorkflowScope;
  baseHash: string | null;
};

type Tab = 'setup' | 'file';

function AgentFields({
  agent,
  onChange,
  onRemove
}: {
  agent: WorkflowAgentDef;
  onChange: (agent: WorkflowAgentDef) => void;
  onRemove?: () => void;
}): React.JSX.Element {
  return (
    <div className="space-y-2 rounded-md border border-fleet-border p-3">
      <div className="flex items-center gap-2">
        <input
          aria-label="Role"
          className={FIELD_CLASS}
          placeholder="Role"
          value={agent.role}
          onChange={(e) => onChange({ ...agent, role: e.target.value })}
        />
        <select
          aria-label="Program"
          className={`${FIELD_CLASS} w-36`}
          value={agent.program}
          onChange={(e) =>
            onChange({ ...agent, program: e.target.value === 'claude' ? 'claude' : 'pi' })
          }
        >
          <option value="pi">Pi</option>
          <option value="claude">Claude Code</option>
        </select>
        {onRemove && (
          <button
            aria-label="Remove"
            onClick={onRemove}
            className="rounded p-1 text-fleet-text-subtle hover:bg-fleet-surface-2 hover:text-fleet-text"
          >
            <X size={13} />
          </button>
        )}
      </div>
      <textarea
        aria-label="Instructions"
        rows={3}
        className={`${FIELD_CLASS} resize-y`}
        placeholder="What this agent does"
        value={agent.prompt}
        onChange={(e) => onChange({ ...agent, prompt: e.target.value })}
      />
    </div>
  );
}

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
        onChange={(e) => onChange({ ...input, type: e.target.value === 'pr' ? 'pr' : 'text' })}
      >
        <option value="text">Text</option>
        <option value="pr">Pull request</option>
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

const NEW_AGENT: WorkflowAgentDef = { role: '', program: 'pi', prompt: '' };

function replaceAt<T>(list: T[], index: number, item: T): T[] {
  return list.map((current, position) => (position === index ? item : current));
}

function FinishFields({
  def,
  onChange
}: {
  def: WorkflowDef;
  onChange: (def: WorkflowDef) => void;
}): React.JSX.Element {
  const action = def.finish?.action ?? 'none';
  const setAction = (value: string): void => {
    if (value === 'post-pr') onChange({ ...def, finish: { action: 'post-pr' } });
    else if (value === 'save-report') onChange({ ...def, finish: { action: 'save-report' } });
    else onChange({ ...def, finish: undefined });
  };
  return (
    <section className="space-y-2">
      <Field label="At the end">
        <select className={FIELD_CLASS} value={action} onChange={(e) => setAction(e.target.value)}>
          <option value="post-pr">Post comments on the PR</option>
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
    </section>
  );
}

function SetupForm({
  def,
  onChange
}: {
  def: WorkflowDef;
  onChange: (def: WorkflowDef) => void;
}): React.JSX.Element {
  return (
    <div className="space-y-5">
      <Field label="Name">
        <input
          className={FIELD_CLASS}
          value={def.name}
          onChange={(e) => onChange({ ...def, name: e.target.value })}
        />
      </Field>
      <Field label="Instructions for all agents">
        <textarea
          rows={3}
          className={`${FIELD_CLASS} resize-y`}
          value={def.shared}
          onChange={(e) => onChange({ ...def, shared: e.target.value })}
        />
      </Field>
      <Field label="Where agents work">
        <select
          className={FIELD_CLASS}
          value={def.workspace}
          onChange={(e) =>
            onChange({
              ...def,
              workspace: e.target.value === 'pr-worktree' ? 'pr-worktree' : 'current'
            })
          }
        >
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

      <section>
        <SectionTitle
          right={
            <Button
              tone="quiet"
              onClick={() =>
                onChange({
                  ...def,
                  inputs: [...def.inputs, { name: '', label: '', type: 'text', required: true }]
                })
              }
            >
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
              onChange={(next) => onChange({ ...def, inputs: replaceAt(def.inputs, index, next) })}
              onRemove={() =>
                onChange({ ...def, inputs: def.inputs.filter((_, at) => at !== index) })
              }
            />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle
          right={
            <Button
              tone="quiet"
              onClick={() => onChange({ ...def, agents: [...def.agents, NEW_AGENT] })}
            >
              <Plus size={12} /> Add agent
            </Button>
          }
        >
          Agents
        </SectionTitle>
        <div className="space-y-2">
          {def.agents.map((agent, index) => (
            <AgentFields
              key={index}
              agent={agent}
              onChange={(next) => onChange({ ...def, agents: replaceAt(def.agents, index, next) })}
              onRemove={
                def.agents.length > 1
                  ? () => onChange({ ...def, agents: def.agents.filter((_, at) => at !== index) })
                  : undefined
              }
            />
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <label className="flex items-center gap-2 text-xs text-fleet-text-secondary">
          <input
            type="checkbox"
            checked={def.judge !== undefined}
            onChange={(e) => onChange({ ...def, judge: e.target.checked ? NEW_AGENT : undefined })}
          />
          Run one last agent after the others finish
        </label>
        {def.judge && (
          <AgentFields agent={def.judge} onChange={(judge) => onChange({ ...def, judge })} />
        )}
      </section>

      <FinishFields def={def} onChange={onChange} />
    </div>
  );
}

function hasComments(text: string): boolean {
  return /^\s*#/m.test(text);
}

export function WorkflowEditor({
  projectPath,
  source,
  onClose
}: {
  projectPath: string;
  source: EditorSource;
  onClose: () => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('setup');
  const [text, setText] = useState(source.text);
  const [scope, setScope] = useState(source.scope);
  const [baseHash, setBaseHash] = useState(source.baseHash);
  const [problem, setProblem] = useState<string | null>(null);
  const [diskText, setDiskText] = useState<string | null>(null);
  const isNew = source.baseHash === null;

  const form = ((): WorkflowDef | null => {
    try {
      return parseToForm(text);
    } catch {
      return null;
    }
  })();

  const save = async (): Promise<void> => {
    const fileName = isNew ? workspaceSlug(form?.name ?? '') || source.fileName : source.fileName;
    const reply = await callWorkflows('save', { projectPath, scope, fileName, text, baseHash });
    if (reply.ok) {
      useToastStore.getState().show('Workflow saved.');
      onClose();
      return;
    }
    setProblem(reply.message);
    setDiskText(reply.diskText ?? null);
  };

  const overwrite = async (): Promise<void> => {
    const entries = await callWorkflows('list', projectPath);
    const onDisk = entries.find((entry) => entry.id === source.fileName);
    setBaseHash(onDisk?.hash ?? null);
    setDiskText(null);
    setProblem('You saw the change on disk. Press Save to replace it.');
  };

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4">
      <div className="flex items-center gap-1">
        <Button tone="quiet" onClick={onClose}>
          Back to Workflows
        </Button>
        <div className="flex-1" />
        {(['project', 'personal'] as const).map((value) => (
          <button
            key={value}
            disabled={!isNew}
            onClick={() => setScope(value)}
            className={`rounded px-2.5 py-1 text-xs capitalize disabled:opacity-50 ${
              scope === value ? 'bg-fleet-surface-2 text-fleet-text' : 'text-fleet-text-subtle'
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      <div className="flex gap-1 border-b border-fleet-border">
        {(['setup', 'file'] as const).map((value) => (
          <button
            key={value}
            disabled={value === 'setup' && form === null}
            onClick={() => setTab(value)}
            className={`-mb-px border-b px-3 py-1.5 text-xs capitalize disabled:opacity-40 ${
              tab === value
                ? 'border-[var(--fleet-accent)] text-fleet-text'
                : 'border-transparent text-fleet-text-subtle'
            }`}
          >
            {value}
          </button>
        ))}
      </div>

      {tab === 'setup' && form ? (
        <div className="space-y-2">
          {hasComments(text) && (
            <p className="rounded border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-200">
              This file has comments. A change here removes them. Use the File tab to keep them.
            </p>
          )}
          <SetupForm def={form} onChange={(next) => setText(formToToml(next))} />
        </div>
      ) : (
        <div className="space-y-1">
          <textarea
            aria-label="Workflow file"
            spellCheck={false}
            rows={24}
            className={`${FIELD_CLASS} resize-y font-mono leading-relaxed`}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <p className="text-[11px] text-fleet-text-subtle">
            This is the file that Fleet saves. Share it, or edit it in any editor.
          </p>
        </div>
      )}

      {problem && (
        <pre className="whitespace-pre-wrap rounded border border-red-500/30 bg-red-500/5 px-3 py-2 font-mono text-[11px] text-red-200">
          {problem}
        </pre>
      )}
      {diskText !== null && (
        <div className="space-y-2">
          <p className="text-xs text-fleet-text-secondary">The file on disk now holds:</p>
          <pre className="max-h-64 overflow-auto rounded border border-fleet-border p-2 font-mono text-[11px] text-fleet-text-muted">
            {diskText}
          </pre>
          <Button onClick={() => void overwrite()}>Use my version</Button>
        </div>
      )}

      <div className="flex justify-end gap-2 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
