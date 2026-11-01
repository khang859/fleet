import { useCallback, useEffect, useState } from 'react';
import type { BuilderInfo, WorkflowEntry } from '../../../../shared/workflows';
import { callWorkflows, showWorkflowError } from '../../store/workflows-store';
import { ApprovalBadge, Button } from './parts';
import { RunSheet } from './RunSheet';
import { ReadOnlyMap } from './StageMap';

type Draft = { info: BuilderInfo; entry: WorkflowEntry | null };

async function readDraft(builderId: string): Promise<Draft | null> {
  const info = await callWorkflows('builderInfo', builderId);
  if (!info) return null;
  const entries = await callWorkflows('list', info.projectPath);
  return { info, entry: entries.find((each) => each.id === info.draftId) ?? null };
}

function useDraft(builderId: string): { draft: Draft | null; reload: () => void } {
  const [draft, setDraft] = useState<Draft | null>(null);

  const reload = useCallback(() => {
    readDraft(builderId).then(setDraft).catch(showWorkflowError);
  }, [builderId]);

  useEffect(() => {
    reload();
    return window.fleet.workflows.onEntries(reload);
  }, [reload]);

  return { draft, reload };
}

function DraftBody({ entry }: { entry: WorkflowEntry }): React.JSX.Element {
  if (!entry.def) {
    return (
      <pre className="whitespace-pre-wrap rounded border border-red-500/30 p-2 font-mono text-[11px] text-red-200">
        {entry.error}
      </pre>
    );
  }
  const { def } = entry;
  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium text-fleet-text">{def.name}</h3>
        {def.shared && (
          <p className="mt-1 whitespace-pre-wrap text-[11px] text-fleet-text-subtle">
            {def.shared}
          </p>
        )}
      </div>
      <ReadOnlyMap def={def} />
      {def.inputs.length > 0 && (
        <p className="text-[11px] text-fleet-text-subtle">
          Fleet asks for: {def.inputs.map((input) => input.label).join(', ')}
        </p>
      )}
    </div>
  );
}

/** Beside a builder's terminal: the file as it is now, and the way to approve it. */
export function DraftPane({ builderId }: { builderId: string }): React.JSX.Element {
  const { draft, reload } = useDraft(builderId);
  const [reviewing, setReviewing] = useState(false);
  const entry = draft?.entry ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-fleet-surface">
      <header className="flex flex-shrink-0 items-center gap-2 border-b border-fleet-border px-3 py-1.5">
        <span className="text-xs font-medium text-fleet-text">Draft</span>
        {entry?.def && <ApprovalBadge approval={entry.approval} />}
        <div className="flex-1" />
        {entry?.def && (
          <Button tone="primary" onClick={() => setReviewing(true)}>
            {entry.approval === 'approved' ? 'Run' : 'Review'}
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {entry ? (
          <DraftBody entry={entry} />
        ) : (
          <p className="py-10 text-center text-[11px] leading-relaxed text-fleet-text-subtle">
            No draft yet. The file shows here after the agent saves it.
          </p>
        )}
      </div>
      {draft && (
        <RunSheet
          projectPath={draft.info.projectPath}
          entry={reviewing ? entry : null}
          onClose={() => {
            setReviewing(false);
            reload();
          }}
        />
      )}
    </div>
  );
}
