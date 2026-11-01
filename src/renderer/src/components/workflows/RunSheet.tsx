import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck } from 'lucide-react';
import {
  agentsOf,
  stagesOf,
  type StartRunRequest,
  type WorkflowCheck,
  type WorkflowEntry,
  type WorkflowPreview,
  type WorkflowProgram
} from '../../../../shared/workflows';
import { whereText } from './workflow-review';
import { callWorkflows, showWorkflowError, useWorkflowsStore } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Overlay } from '../Overlay';
import { Badge, Button, Field, FIELD_CLASS } from './parts';
import { ChangeView } from './ChangeView';

type Choices = {
  force: boolean;
  allowClosedPr: boolean;
  trustPr: boolean;
  programOverride?: WorkflowProgram;
};

const NO_CHOICES: Choices = { force: false, allowClosedPr: false, trustPr: false };

const PREVIEW_DELAY_MS = 350;

function CheckRow({
  check,
  onFix
}: {
  check: WorkflowCheck;
  onFix: (fix: string) => void;
}): React.JSX.Element {
  const Icon = check.ok ? CircleCheck : CircleAlert;
  return (
    <li className="flex items-start gap-2 text-[11px]">
      <Icon
        size={13}
        className={`mt-px flex-shrink-0 ${check.ok ? 'text-emerald-400' : 'text-amber-400'}`}
      />
      <span className="min-w-0 flex-1">
        <span className="text-fleet-text-secondary">{check.label}</span>
        {!check.ok && check.detail && (
          <span className="block text-fleet-text-subtle">{check.detail}</span>
        )}
      </span>
      {!check.ok && check.fix && (
        <button
          className="flex-shrink-0 text-[var(--fleet-accent-hover)] hover:underline"
          onClick={() => onFix(check.fix ?? '')}
        >
          {check.fix}
        </button>
      )}
    </li>
  );
}

function usePreview(request: StartRunRequest | null): WorkflowPreview | null {
  const [preview, setPreview] = useState<WorkflowPreview | null>(null);
  const key = JSON.stringify(request);

  useEffect(() => {
    if (!request) return;
    let live = true;
    const timer = setTimeout(() => {
      callWorkflows('preview', request)
        .then((reply) => {
          if (live) setPreview(reply);
        })
        .catch(showWorkflowError);
    }, PREVIEW_DELAY_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The key holds every field of the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return request ? preview : null;
}

function planLines(entry: WorkflowEntry): string[] {
  const { def } = entry;
  if (!def) return [];
  const stages = stagesOf(def);
  const count = agentsOf(def).length;
  const last = stages[stages.length - 1].agents;
  return [
    `${whereText(def)}.`,
    stages.length > 1 && def.stages
      ? `Run ${stages.length} stages in order: ${stages.map((stage) => stage.name).join(', ')}.`
      : `Open ${count} ${count === 1 ? 'pane' : 'panes'}, one for each agent.`,
    last.length === 1 && (def.judge || def.stages)
      ? `${last[0].role} goes last and writes the report.`
      : 'Join the agent summaries.'
  ];
}

function Inputs({
  entry,
  values,
  onChange
}: {
  entry: WorkflowEntry;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}): React.JSX.Element | null {
  const inputs = entry.def?.inputs ?? [];
  if (inputs.length === 0) return null;
  return (
    <div className="space-y-3">
      {inputs.map((input) => (
        <Field key={input.name} label={input.label}>
          <textarea
            autoFocus={inputs[0] === input}
            rows={input.type === 'pr' ? 1 : 3}
            className={`${FIELD_CLASS} resize-none`}
            placeholder={input.type === 'pr' ? 'A PR number or link' : ''}
            value={values[input.name] ?? ''}
            onChange={(e) => onChange({ ...values, [input.name]: e.target.value })}
          />
        </Field>
      ))}
    </div>
  );
}

function PrLine({
  preview,
  trusted,
  onTrust
}: {
  preview: WorkflowPreview;
  trusted: boolean;
  onTrust: () => void;
}): React.JSX.Element | null {
  const { pr } = preview;
  if (!pr) return null;
  return (
    <div className="rounded border border-fleet-border px-2.5 py-2 text-[11px]">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-fleet-text-secondary">
          #{pr.number} {pr.title}
        </span>
        {pr.locked && <Badge tone="amber">Locked</Badge>}
        {trusted && <Badge tone="blue">Trusted</Badge>}
      </div>
      {pr.locked && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-fleet-text-subtle">
          <span>This PR comes from outside the team. Agents start with read-only tools.</span>
          <Button onClick={onTrust}>Trust this PR</Button>
        </div>
      )}
    </div>
  );
}

function RunPlan({ entry }: { entry: WorkflowEntry }): React.JSX.Element {
  return (
    <div>
      <div className="pb-1.5 text-[11px] font-medium text-fleet-text-muted">What Fleet will do</div>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-fleet-text-subtle">
        {planLines(entry).map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

function DuplicateNotice({
  onOpen,
  onForce
}: {
  onOpen: () => void;
  onForce: () => void;
}): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-amber-500/30 px-2.5 py-2 text-[11px] text-amber-200">
      <span>This workflow is already running for this target.</span>
      <Button onClick={onOpen}>Open the run</Button>
      <Button onClick={onForce}>Run anyway</Button>
    </div>
  );
}

function CheckList({
  preview,
  onFix
}: {
  preview: WorkflowPreview;
  onFix: (fix: string) => void;
}): React.JSX.Element {
  return (
    <>
      <ul className="space-y-1.5">
        {preview.checks.map((check) => (
          <CheckRow key={check.label} check={check} onFix={onFix} />
        ))}
      </ul>
      {preview.programNotes.map((note) => (
        <p key={note} className="text-[11px] text-amber-200">
          {note}
        </p>
      ))}
    </>
  );
}

function RunForm({
  entry,
  values,
  onChange,
  preview,
  trusted,
  onTrust,
  onFix
}: {
  entry: WorkflowEntry;
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
  preview: WorkflowPreview | null;
  trusted: boolean;
  onTrust: () => void;
  onFix: (fix: string) => void;
}): React.JSX.Element {
  return (
    <>
      <Inputs entry={entry} values={values} onChange={onChange} />
      {preview && <PrLine preview={preview} trusted={trusted} onTrust={onTrust} />}
      <RunPlan entry={entry} />
      {preview && <CheckList preview={preview} onFix={onFix} />}
    </>
  );
}

function SheetFooter({
  needsApproval,
  starting,
  disabled,
  approveDisabled,
  onCancel,
  onApprove,
  onStart
}: {
  needsApproval: boolean;
  starting: boolean;
  disabled: boolean;
  approveDisabled: boolean;
  onCancel: () => void;
  onApprove: () => unknown;
  onStart: () => unknown;
}): React.JSX.Element {
  return (
    <div className="flex justify-end gap-2 border-t border-fleet-border px-4 py-3">
      <Button onClick={onCancel}>Cancel</Button>
      {needsApproval ? (
        <Button tone="primary" disabled={approveDisabled} onClick={onApprove}>
          Approve
        </Button>
      ) : (
        <Button tone="primary" disabled={disabled} onClick={onStart}>
          {starting ? 'Starting' : 'Start'}
        </Button>
      )}
    </div>
  );
}

function missingInput(entry: WorkflowEntry | null, values: Record<string, string>): boolean {
  return (entry?.def?.inputs ?? []).some(
    (input) => input.required && (values[input.name] ?? '').trim() === ''
  );
}

function fixChoice(fix: string): Partial<Choices> {
  if (fix === 'Review it anyway') return { allowClosedPr: true };
  if (fix === 'Use Pi for this run') return { programOverride: 'pi' };
  if (fix === 'Use Claude Code for this run') return { programOverride: 'claude' };
  return {};
}

function sheetTitle(entry: WorkflowEntry | null): string {
  if (!entry) return '';
  const verb = entry.approval === 'approved' ? 'Run' : 'Review';
  return `${verb} ${entry.def?.name ?? entry.id}`;
}

function SheetProblems({
  error,
  problem
}: {
  error: string | null | undefined;
  problem: string | null;
}): React.JSX.Element {
  return (
    <>
      {error && (
        <pre className="whitespace-pre-wrap font-mono text-[11px] text-red-300">{error}</pre>
      )}
      {problem && <p className="text-xs text-red-300">{problem}</p>}
    </>
  );
}

function useStartRun(
  request: StartRunRequest | null,
  onClose: () => void,
  onProblem: (message: string) => void
): { starting: boolean; start: () => Promise<void> } {
  const openRun = useWorkflowsStore((s) => s.openRun);
  const [starting, setStarting] = useState(false);

  const start = async (): Promise<void> => {
    if (!request) return;
    setStarting(true);
    try {
      const reply = await callWorkflows('start', request);
      if (reply.ok) {
        onClose();
        openRun(reply.runId);
        return;
      }
      onProblem(reply.message);
    } finally {
      setStarting(false);
    }
  };

  return { starting, start };
}

export function RunSheet({
  projectPath,
  entry,
  initialInputs,
  onClose
}: {
  projectPath: string;
  entry: WorkflowEntry | null;
  initialInputs?: Record<string, string>;
  onClose: () => void;
}): React.JSX.Element {
  const openRun = useWorkflowsStore((s) => s.openRun);
  const [values, setValues] = useState<Record<string, string>>({});
  const [choices, setChoices] = useState<Choices>(NO_CHOICES);
  const [problem, setProblem] = useState<string | null>(null);
  const [readHash, setReadHash] = useState<string | null>(null);
  const entryId = entry?.id;

  // The entry is live, so a change to the file must not clear what a person typed.
  useEffect(() => {
    setValues(initialInputs ?? {});
    setChoices(NO_CHOICES);
    setProblem(null);
    setReadHash(null);
  }, [entryId, initialInputs]);

  const needsApproval = entry !== null && entry.approval !== 'approved';

  // The panel keeps its size while it closes, when the entry is already gone.
  const [wide, setWide] = useState(false);
  if (entry && wide !== needsApproval) setWide(needsApproval);

  const request: StartRunRequest | null = entry
    ? { projectPath, workflowId: entry.id, inputs: values, ...choices }
    : null;
  const preview = usePreview(needsApproval ? null : request);
  const failed = preview?.checks.some((check) => !check.ok) ?? false;
  const broken = entry?.def === null;
  const missing = missingInput(entry, values);
  const { starting, start } = useStartRun(request, onClose, setProblem);

  const applyFix = (fix: string): void => setChoices({ ...choices, ...fixChoice(fix) });

  const approve = async (): Promise<void> => {
    if (!entry || readHash === null) return;
    const approved = await callWorkflows('approve', projectPath, entry.id, readHash);
    if (!approved) {
      setProblem('The file changed again. Check it once more.');
      return;
    }
    useToastStore.getState().show(`Approved ${entry.def?.name ?? entry.id}.`);
    onClose();
  };

  const duplicate = preview?.duplicateRunId ?? null;
  const blocked = duplicate !== null && !choices.force;

  return (
    <Overlay
      open={entry !== null}
      onClose={onClose}
      panelClassName={`flex flex-col rounded-lg border border-fleet-border-strong bg-fleet-surface ${
        wide ? 'h-[85vh] w-[52rem] max-w-[calc(100vw-2rem)]' : 'max-h-[80vh] w-[28rem]'
      }`}
    >
      <div className="border-b border-fleet-border px-4 py-3 text-sm font-medium text-fleet-text">
        {sheetTitle(entry)}
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {entry && needsApproval && <ChangeView entry={entry} onRead={setReadHash} />}
        {entry && !needsApproval && (
          <RunForm
            entry={entry}
            values={values}
            onChange={setValues}
            preview={preview}
            trusted={choices.trustPr}
            onTrust={() => setChoices({ ...choices, trustPr: true })}
            onFix={applyFix}
          />
        )}
        {duplicate && !choices.force && (
          <DuplicateNotice
            onOpen={() => {
              onClose();
              openRun(duplicate);
            }}
            onForce={() => setChoices({ ...choices, force: true })}
          />
        )}
        <SheetProblems error={entry?.error} problem={problem} />
      </div>
      <SheetFooter
        needsApproval={needsApproval}
        starting={starting}
        disabled={starting || missing || failed || blocked || broken}
        approveDisabled={broken || readHash !== entry?.hash}
        onCancel={onClose}
        onApprove={approve}
        onStart={start}
      />
    </Overlay>
  );
}
