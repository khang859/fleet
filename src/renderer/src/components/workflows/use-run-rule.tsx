import { useState } from 'react';
import type { WorkflowRule } from '../../../../shared/workflows';
import { useToastStore } from '../../store/toast-store';
import { callWorkflows, useWorkflowsStore } from '../../store/workflows-store';
import { RunSheet } from './RunSheet';
import { hasPrInput } from './workflow-format';

type PrSheet = { rule: WorkflowRule; workflowId: string };

/** The workflow a new-PR rule starts, when Run now must ask which PR. */
async function prSheetFor(rule: WorkflowRule | undefined): Promise<PrSheet | null> {
  if (rule?.trigger.kind !== 'new-pr') return null;
  await useWorkflowsStore.getState().setProject(rule.projectPath);
  const { entries } = useWorkflowsStore.getState();
  const entry = entries.find((item) => item.id === rule.workflowId);
  return entry && hasPrInput(entry) ? { rule, workflowId: entry.id } : null;
}

async function startRule(ruleId: string): Promise<void> {
  const reply = await callWorkflows('runRule', ruleId);
  if (!reply.ok) useToastStore.getState().show(reply.reason ?? 'The rule did not start.');
}

/** Run now for a rule. A new-PR rule first asks which PR, in the run sheet. */
export function useRunRule(): {
  runNow: (ruleId: string) => Promise<void>;
  sheet: React.JSX.Element;
} {
  const [prSheet, setPrSheet] = useState<PrSheet | null>(null);
  const entry = useWorkflowsStore((s) => s.entries.find((e) => e.id === prSheet?.workflowId));

  const open = async (ruleId: string): Promise<void> => {
    const { rules } = useWorkflowsStore.getState().state;
    const found = await prSheetFor(rules.find((rule) => rule.id === ruleId));
    if (found) setPrSheet(found);
    else await startRule(ruleId);
  };

  const sheet = (
    <RunSheet
      projectPath={prSheet?.rule.projectPath ?? ''}
      entry={entry ?? null}
      initialInputs={prSheet?.rule.inputs}
      onClose={() => setPrSheet(null)}
    />
  );

  return { runNow: open, sheet };
}
