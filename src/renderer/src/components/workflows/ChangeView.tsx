import { useEffect, useState } from 'react';
import type { WorkflowEntry } from '../../../../shared/workflows';
import { callWorkflows } from '../../store/workflows-store';

type Line = { sign: '+' | '-' | ' '; text: string };

/** A plain line compare. It shows what a person must read, and keeps the order of the new file. */
function changedLines(oldText: string, newText: string): Line[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const removed: Line[] = oldLines
    .filter((line) => !newSet.has(line))
    .map((text) => ({ sign: '-', text }));
  const added: Line[] = newLines
    .filter((line) => !oldSet.has(line))
    .map((text) => ({ sign: '+', text }));
  return [...removed, ...added];
}

const LINE_CLASS: Record<Line['sign'], string> = {
  '+': 'bg-emerald-500/10 text-emerald-200',
  '-': 'bg-red-500/10 text-red-200',
  ' ': 'text-fleet-text-muted'
};

/** Approval: the whole file when it is new, and only the change when it is not. */
export function ChangeView({ entry }: { entry: WorkflowEntry }): React.JSX.Element {
  const [text, setText] = useState<string | null>(null);

  useEffect(() => {
    void callWorkflows('readText', entry.path).then(setText);
  }, [entry.path, entry.hash]);

  if (text === null) return <div />;
  const { approvedText } = entry;
  const lines: Line[] =
    approvedText === null
      ? text.split('\n').map((line) => ({ sign: ' ', text: line }))
      : changedLines(approvedText, text);

  return (
    <div className="space-y-2">
      <p className="text-xs leading-relaxed text-fleet-text-secondary">
        {approvedText === null
          ? 'Fleet has not seen this file. Prompts can tell an agent to do anything, so read it first.'
          : 'This file changed since you approved it. Read what changed.'}
      </p>
      <pre className="max-h-80 overflow-auto rounded border border-fleet-border font-mono text-[11px] leading-relaxed">
        {lines.map((line, index) => (
          <div key={index} className={`px-2 ${LINE_CLASS[line.sign]}`}>
            {line.sign === ' ' ? line.text : `${line.sign} ${line.text}`}
          </div>
        ))}
      </pre>
    </div>
  );
}
