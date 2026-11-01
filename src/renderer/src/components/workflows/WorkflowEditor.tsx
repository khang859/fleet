import { useEffect, useState } from 'react';
import type { WorkflowDef, WorkflowScope } from '../../../../shared/workflows';
import { workspaceSlug } from '../../../../shared/claude-config';
import { callWorkflows } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Button, FIELD_CLASS } from './parts';
import { StageEditor } from './StageEditor';
import { formToToml, parseToForm } from './workflow-toml';

export type EditorSource = {
  text: string;
  fileName: string;
  scope: WorkflowScope;
  baseHash: string | null;
};

type Tab = 'setup' | 'file';

const CHECK_WAIT_MS = 250;

/** What Save would refuse, while a person edits. */
function useFileCheck(text: string): string | null {
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => {
      callWorkflows('check', text)
        .then(setProblem)
        .catch(() => setProblem(null));
    }, CHECK_WAIT_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return problem;
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
  const checkProblem = useFileCheck(text);
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
    <div className="mx-auto max-w-6xl space-y-4 p-4">
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
          <StageEditor
            def={form}
            projectPath={projectPath}
            onChange={(next) => setText(formToToml(next))}
          />
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

      {checkProblem && !problem && (
        <pre className="whitespace-pre-wrap rounded border border-amber-500/30 px-3 py-2 font-mono text-[11px] text-amber-200">
          {checkProblem}
        </pre>
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
          <Button onClick={overwrite}>Use my version</Button>
        </div>
      )}

      <div className="flex justify-end gap-2 pb-4">
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" disabled={checkProblem !== null} onClick={save}>
          Save
        </Button>
      </div>
    </div>
  );
}
