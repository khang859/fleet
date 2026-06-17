import { createLogger } from '../logger';
import type { KanbanStore } from './kanban-store';
import type { Task } from '../../shared/kanban-types';
import type { PipelineTemplate } from './pipeline-templates';

const log = createLogger('template-expander');

/** Profile roles the full_feature pipeline requires; missing any ⇒ fall back to quick_fix. */
const REQUIRED_ROLES = ['explorer', 'architect', 'qa'] as const;

/** Event kind written on the root once expansion has run, for reclaim-safe idempotency. */
export const PIPELINE_EXPANDED_EVENT = 'pipeline_expanded';

export interface ExpanderDeps {
  /** Profile names present per role, used for the graceful-degradation check. */
  hasRole: (role: string) => boolean;
}

/**
 * Lay down the full_feature skeleton for a triage root task, mirroring createSwarm:
 * ensure a feature, then create explore(ready) → spec(todo) → gate(blocked) → qa(todo)
 * with the gating links. The implement-children fan-out is NOT created here — the
 * architect emits it at the spec stage (§5). Idempotent: re-running is a no-op once
 * the PIPELINE_EXPANDED_EVENT is present. Falls back to quick_fix (no expansion) if a
 * required role profile is missing.
 */
export function expandTemplate(
  root: Task,
  template: PipelineTemplate,
  store: KanbanStore,
  deps: ExpanderDeps
): void {
  if (template.id !== 'full_feature') return; // quick_fix / inert: no expansion

  // Idempotency: a prior expansion left an event on the root.
  if (store.listEvents(root.id).some((e) => e.kind === PIPELINE_EXPANDED_EVENT)) {
    return;
  }

  // Graceful degradation: a missing SDLC role makes the pipeline unrunnable, so
  // degrade to quick_fix (root runs the normal flow) rather than wedging.
  const missing = REQUIRED_ROLES.filter((r) => !deps.hasRole(r));
  if (missing.length > 0) {
    log.warn('pipeline role(s) missing; falling back to quick_fix', {
      rootId: root.id,
      missing
    });
    store.appendEvent(root.id, null, PIPELINE_EXPANDED_EVENT, {
      fallback: 'quick_fix',
      missing
    });
    return; // root stays a triage task and runs today's flow
  }

  store.transaction(() => {
    // 1. Ensure the root has a feature so all stages ship as one unit.
    let featureId = root.featureId;
    if (!featureId) {
      const feature = store.createFeature({
        boardId: root.boardId,
        name: root.title,
        repoPath: root.repoPath,
        baseBranch: root.baseBranch
      });
      featureId = feature.id;
      store.setFeatureId(root.id, featureId);
    }

    const common = {
      boardId: root.boardId,
      featureId,
      repoPath: root.repoPath ?? undefined,
      baseBranch: root.baseBranch ?? null,
      priority: root.priority
    };

    // 2. explore (read-only mapping) — starts ready so it spawns immediately.
    const explore = store.createTask({
      title: `Explore: ${root.title}`,
      body:
        `Map the codebase relevant to root task ${root.id}: affected files/modules/patterns, ` +
        `risks and unknowns. Write NO code. Register findings as a kanban_artifact and post a ` +
        `one-paragraph summary comment on ${root.id}.\n\nRoot:\n${root.body}`,
      assignee: 'explorer',
      status: 'ready',
      pipelineStage: 'explore',
      ...common
    });

    // 3. spec (architect) — gated on explore.
    const spec = store.createTask({
      title: `Spec: ${root.title}`,
      body:
        `Read the explore artifact + root task ${root.id}, write a concrete implementation spec, ` +
        `then fan out implementation work by calling kanban_create once per unit (the create path ` +
        `wires links + feature for you). Do not implement. Root:\n${root.body}`,
      assignee: 'architect',
      status: 'todo',
      pipelineStage: 'spec',
      ...common
    });
    store.addLink(explore.id, spec.id);

    // 4. gate — blocked; only executeProposal('approve_spec') moves it to done.
    const gate = store.createTask({
      title: `Approve spec: ${root.title}`,
      body: `Spec approval gate for feature ${featureId}. Released only by an approve_spec proposal.`,
      status: 'blocked',
      systemKind: 'pipeline_gate',
      pipelineStage: 'gate',
      ...common
    });
    store.addLink(spec.id, gate.id);

    // 5. qa — gated on the gate (baseline; implement children also link → qa in §5).
    const qa = store.createTask({
      title: `QA: ${root.title}`,
      body:
        `Validate feature ${featureId} against root task ${root.id}'s acceptance criteria. Run the ` +
        `project verify commands, exercise end-to-end behavior, check explore-identified risks, then ` +
        `emit a verdict.`,
      assignee: 'qa',
      status: 'todo',
      pipelineStage: 'qa',
      ...common
    });
    store.addLink(gate.id, qa.id);

    // 6. Idempotency marker + audit record of the laid-down graph.
    store.appendEvent(root.id, null, PIPELINE_EXPANDED_EVENT, {
      featureId,
      exploreId: explore.id,
      specId: spec.id,
      gateId: gate.id,
      qaId: qa.id
    });
    // The root is the planning anchor; complete it so it doesn't sit in triage.
    store.completeTask(root.id, 'Pipeline expanded; stages laid down.');
  });
}
