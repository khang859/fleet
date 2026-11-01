import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type {
  PlanAnswer,
  PlanBuildMode,
  RunAgent,
  WorkflowRun
} from '../../../../shared/workflows';
import { PLAN_APPROVAL_CHOICES } from '../../../copilot/src/lib/format-permission';
import { callWorkflows, showWorkflowError } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { MarkdownPreview } from '../markdown/MarkdownPreview';
import { Badge, Button, FIELD_CLASS } from './parts';
import { planSections, type PlanSection } from './plan-sections';

function usePlanText(runId: string, version: number | undefined): string | null {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    setText(null);
    if (version === undefined) return;
    callWorkflows('readPlan', runId, version).then(setText).catch(showWorkflowError);
  }, [runId, version]);

  return text;
}

function SectionList({
  sections,
  onJump
}: {
  sections: PlanSection[];
  onJump: (section: PlanSection) => void;
}): React.JSX.Element {
  return (
    <nav aria-label="Plan sections" className="space-y-0.5">
      <p className="px-2 pb-1 text-[11px] font-medium text-fleet-text-muted">Sections</p>
      {sections.map((section, index) => (
        <button
          key={index}
          onClick={() => onJump(section)}
          style={{ paddingLeft: `${section.level * 8}px` }}
          className="block w-full truncate rounded py-1 pr-2 text-left text-[11px] text-fleet-text-secondary hover:bg-fleet-surface-2 hover:text-fleet-text"
        >
          {section.title}
        </button>
      ))}
    </nav>
  );
}

function BuildModes({
  mode,
  onChange
}: {
  mode: PlanBuildMode;
  onChange: (mode: PlanBuildMode) => void;
}): React.JSX.Element {
  return (
    <fieldset className="space-y-1">
      <legend className="pb-1 text-[11px] font-medium text-fleet-text-muted">
        Then build with
      </legend>
      {PLAN_APPROVAL_CHOICES.map((choice) => (
        <label
          key={choice.mode}
          className="flex items-center gap-2 text-xs text-fleet-text-secondary"
        >
          <input
            type="radio"
            name="plan-build-mode"
            checked={mode === choice.mode}
            onChange={() => onChange(choice.mode)}
          />
          {choice.label.replace('Allow, and ', '').replace(/^./, (first) => first.toUpperCase())}
        </label>
      ))}
    </fieldset>
  );
}

function AnswerPanel({
  run,
  agent,
  onDone
}: {
  run: WorkflowRun;
  agent: RunAgent;
  onDone: () => void;
}): React.JSX.Element {
  const [mode, setMode] = useState<PlanBuildMode>('auto');
  const [change, setChange] = useState('');
  const isClaude = agent.program === 'claude';

  const answer = async (reply: PlanAnswer): Promise<void> => {
    const sent = await callWorkflows('answerPlan', run.id, agent.id, reply);
    if (sent) onDone();
    else useToastStore.getState().show('The agent is not there. Answer in its pane.');
  };

  return (
    <div className="space-y-4">
      {isClaude && <BuildModes mode={mode} onChange={setMode} />}
      <Button
        tone="primary"
        className="w-full justify-center"
        onClick={async () => answer(isClaude ? { kind: 'approve', mode } : { kind: 'approve' })}
      >
        Approve the plan
      </Button>
      {!isClaude && (
        <p className="text-[11px] text-fleet-text-subtle">
          Pi starts again on the same session, and then it can change code.
        </p>
      )}
      <div className="space-y-1.5 border-t border-fleet-border pt-3">
        <textarea
          aria-label="What to change"
          rows={5}
          className={`${FIELD_CLASS} resize-y`}
          placeholder="What must change?"
          value={change}
          onChange={(e) => setChange(e.target.value)}
        />
        <Button
          disabled={change.trim() === ''}
          onClick={async () => answer({ kind: 'change', text: change })}
        >
          Ask for changes
        </Button>
      </div>
    </div>
  );
}

function PlanStatus({ agent }: { agent: RunAgent }): React.JSX.Element {
  if (agent.pendingPlan) return <Badge tone="amber">Waits for you</Badge>;
  return agent.planApproved ? <Badge tone="green">Approved</Badge> : <Badge tone="gray">Old</Badge>;
}

/** A plan is a long document, so it gets the whole page at full reading size. */
export function PlanPage({
  run,
  agent,
  onBack
}: {
  run: WorkflowRun;
  agent: RunAgent;
  onBack: () => void;
}): React.JSX.Element {
  const plans = agent.plans ?? [];
  const latest = plans.at(-1)?.version;
  const [picked, setPicked] = useState<number | null>(null);
  const version = picked ?? agent.pendingPlan?.version ?? latest;
  const text = usePlanText(run.id, version);
  const body = useRef<HTMLDivElement>(null);
  const sections = planSections(text ?? '');
  const isLatest = version === (agent.pendingPlan?.version ?? latest);

  const jump = (section: PlanSection): void => {
    const headings = body.current?.querySelectorAll('h1, h2, h3') ?? [];
    const target = [...headings].find((el) => el.textContent.trim() === section.title);
    target?.scrollIntoView({ block: 'start' });
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-2 border-b border-fleet-border px-4 py-2">
        <Button tone="quiet" aria-label="Back to the run" onClick={onBack}>
          <ArrowLeft size={13} />
        </Button>
        <h2 className="min-w-0 truncate text-sm font-medium text-fleet-text">
          Plan from {agent.role}
        </h2>
        <PlanStatus agent={agent} />
        <div className="flex-1" />
        {plans.length > 1 && (
          <div className="w-32">
            <select
              aria-label="Plan version"
              className={FIELD_CLASS}
              value={version}
              onChange={(e) => setPicked(Number(e.target.value))}
            >
              {plans.map((plan, index) => (
                <option key={plan.version} value={plan.version}>
                  Version {index + 1}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {sections.length > 1 && (
          <aside className="hidden w-48 flex-shrink-0 overflow-y-auto border-r border-fleet-border p-2 lg:block">
            <SectionList sections={sections} onJump={jump} />
          </aside>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl p-6">
            {text === null ? (
              <p className="text-xs text-fleet-text-subtle">This plan cannot be read.</p>
            ) : (
              <div ref={body}>
                <MarkdownPreview content={text} baseDir={run.cwd} />
              </div>
            )}
          </div>
        </div>
        {agent.pendingPlan && isLatest && (
          <aside className="flex-shrink-0 overflow-y-auto border-t border-fleet-border p-3 md:w-64 md:border-l md:border-t-0">
            <AnswerPanel run={run} agent={agent} onDone={onBack} />
          </aside>
        )}
      </div>
    </div>
  );
}
