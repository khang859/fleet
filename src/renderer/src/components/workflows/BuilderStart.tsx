import { useState } from 'react';
import type { WorkflowProgram } from '../../../../shared/workflows';
import { callWorkflows } from '../../store/workflows-store';
import { Overlay } from '../Overlay';
import { usePrograms } from './use-programs';
import { Button } from './parts';

const IS_WINDOWS = window.fleet.platform === 'win32';

type Choice = {
  program: WorkflowProgram;
  label: string;
  detail: string;
};

const CHOICES: Choice[] = [
  {
    program: 'claude',
    label: 'Claude Code',
    detail: 'It runs in a real terminal pane, so your Claude subscription works.'
  },
  { program: 'pi', label: 'Pi', detail: 'It runs in a real terminal pane, with your Pi setup.' }
];

function whyNot(program: WorkflowProgram, installed: boolean): string | null {
  if (program === 'claude' && IS_WINDOWS) return 'Claude Code has no Fleet tools on Windows.';
  return installed ? null : 'It is not installed.';
}

/** The program is a start choice, because a running pane cannot change it. */
export function BuilderStart({
  open,
  projectPath,
  onClose
}: {
  open: boolean;
  projectPath: string;
  onClose: () => void;
}): React.JSX.Element {
  const programs = usePrograms(open);
  const [program, setProgram] = useState<WorkflowProgram>(IS_WINDOWS ? 'pi' : 'claude');
  const [problem, setProblem] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    const reply = await callWorkflows('startBuilder', projectPath, program);
    if (reply.ok) onClose();
    else setProblem(reply.message);
  };

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-[26rem] max-w-[calc(100vw-2rem)] rounded-lg border border-fleet-border-strong bg-fleet-surface p-4"
    >
      <h3 className="text-xs font-medium text-fleet-text">Make a workflow with an agent</h3>
      <p className="mt-1 text-[11px] leading-relaxed text-fleet-text-subtle">
        Tell the agent how you work. It asks questions and writes the workflow. It cannot change
        your code in this pane. You see each draft beside it, and you approve the file.
      </p>
      <div className="mt-3 space-y-1.5" role="radiogroup" aria-label="Program">
        {CHOICES.map((choice) => {
          const blocked = whyNot(choice.program, programs[choice.program]);
          return (
            <label
              key={choice.program}
              className={`flex items-start gap-2 rounded-md border p-2 ${
                program === choice.program ? 'border-[var(--fleet-accent)]' : 'border-fleet-border'
              } ${blocked ? 'opacity-60' : ''}`}
            >
              <input
                type="radio"
                name="builder-program"
                className="mt-0.5"
                disabled={blocked !== null}
                checked={program === choice.program}
                onChange={() => setProgram(choice.program)}
              />
              <span>
                <span className="block text-xs text-fleet-text">{choice.label}</span>
                <span className="block text-[11px] text-fleet-text-subtle">
                  {blocked ?? choice.detail}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {IS_WINDOWS && (
        <p className="mt-2 text-[11px] text-fleet-text-subtle">
          On Windows, use Pi, or use New workflow to make the file in the editor.
        </p>
      )}
      {problem && <p className="mt-2 text-[11px] text-red-300">{problem}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" onClick={start}>
          Start
        </Button>
      </div>
    </Overlay>
  );
}
