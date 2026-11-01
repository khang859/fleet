import { useEffect, useState } from 'react';
import type { SaveReportResult, WorkflowRun } from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError } from '../../store/workflows-store';
import { useToastStore } from '../../store/toast-store';
import { Overlay } from '../Overlay';
import { Button, Field, FIELD_CLASS } from './parts';

function withNewName(path: string): string {
  const stem = path.replace(/\.md$/, '');
  const match = /-(\d+)$/.exec(stem);
  return match ? `${stem.slice(0, -match[0].length)}-${Number(match[1]) + 1}.md` : `${stem}-2.md`;
}

export function SaveReportDialog({
  run,
  open,
  onClose
}: {
  run: WorkflowRun;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [path, setPath] = useState('');
  const [failure, setFailure] = useState<Extract<SaveReportResult, { ok: false }> | null>(null);

  useEffect(() => {
    if (!open) return;
    setFailure(null);
    callWorkflows('reportPath', run.id)
      .then((suggested) => {
        setPath(suggested ?? `docs/reports/${run.slug || run.workflowId}.md`);
      })
      .catch(showWorkflowError);
  }, [open, run.id, run.slug, run.workflowId]);

  const settle = (reply: SaveReportResult | null): void => {
    if (!reply) return;
    if (reply.ok) {
      useToastStore.getState().show(`Saved to ${reply.path}`);
      onClose();
    } else {
      setFailure(reply);
    }
  };

  const save = async (replace: boolean): Promise<void> => {
    settle(await callWorkflows('saveReport', run.id, path, replace));
  };

  const choose = async (): Promise<void> => {
    settle(await callWorkflows('pickReportPath', run.id));
  };

  const exists = failure?.code === 'exists';

  return (
    <Overlay
      open={open}
      onClose={onClose}
      panelClassName="w-[28rem] space-y-3 rounded-lg border border-fleet-border-strong bg-fleet-surface p-4"
    >
      <Field label="Save to" hint="A path inside the project. Use Choose to pick any folder.">
        <input
          className={`${FIELD_CLASS} font-mono`}
          value={path}
          onChange={(e) => {
            setPath(e.target.value);
            setFailure(null);
          }}
        />
      </Field>
      {failure && <p className="text-[11px] text-red-300">{failure.message}</p>}
      <div className="flex justify-end gap-2">
        <Button tone="quiet" onClick={choose}>
          Choose
        </Button>
        <div className="flex-1" />
        <Button onClick={onClose}>Cancel</Button>
        {exists ? (
          <>
            <Button
              onClick={() => {
                setPath(withNewName(path));
                setFailure(null);
              }}
            >
              Use a new name
            </Button>
            <Button tone="danger" onClick={async () => save(true)}>
              Replace
            </Button>
          </>
        ) : (
          <Button tone="primary" onClick={async () => save(false)}>
            {failure?.code === 'failed' ? 'Try again' : 'Save'}
          </Button>
        )}
      </div>
    </Overlay>
  );
}
