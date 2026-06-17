import type { PipelineTemplateId, StageKind } from '../../shared/kanban-types';

export interface PipelineTemplate {
  id: PipelineTemplateId;
  /**
   * Ordered stages the expander lays down. Excludes the LLM-fanned implement
   * children + their per-child review, which the architect emits at the spec stage.
   */
  stages: StageKind[];
}

/** Max implement children the architect may fan out at the spec stage (spec §5). */
export const MAX_FANOUT = 12;

/** QA request_changes re-arm cycles before the feature is blocked (spec §8). */
export const QA_ATTEMPT_CAP = 2;

export const FULL_FEATURE: PipelineTemplate = {
  id: 'full_feature',
  stages: ['explore', 'spec', 'gate', 'qa']
};

export const QUICK_FIX: PipelineTemplate = {
  id: 'quick_fix',
  // No expansion: the root task runs today's work → review flow unchanged.
  stages: []
};

/** Look up a template by id. Returns QUICK_FIX for null/unknown (the inert default). */
export function getTemplate(id: PipelineTemplateId | null | undefined): PipelineTemplate {
  return id === 'full_feature' ? FULL_FEATURE : QUICK_FIX;
}
