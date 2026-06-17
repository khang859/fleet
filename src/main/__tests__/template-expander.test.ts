import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { KanbanStore } from '../kanban/kanban-store';
import { expandTemplate, PIPELINE_EXPANDED_EVENT } from '../kanban/template-expander';
import { FULL_FEATURE, QUICK_FIX } from '../kanban/pipeline-templates';

const DIR = join(tmpdir(), `fleet-expander-test-${Date.now()}`);
const allRoles = { hasRole: () => true };

function store(): KanbanStore {
  return new KanbanStore(join(DIR, `e-${Math.random()}.db`), { now: () => 1000 });
}

function stageOf(s: KanbanStore, id: string): string | null {
  return s.getTask(id)?.pipelineStage ?? null;
}

describe('expandTemplate', () => {
  beforeEach(() => mkdirSync(DIR, { recursive: true }));
  afterEach(() => rmSync(DIR, { recursive: true, force: true }));

  it('lays down explore→spec→gate→qa with the gating links + a feature', () => {
    const s = store();
    const root = s.createTask({ title: 'Add billing', pipelineTemplate: 'full_feature' });
    expandTemplate(root, FULL_FEATURE, s, allRoles);

    const ev = s.listEvents(root.id).find((e) => e.kind === PIPELINE_EXPANDED_EVENT);
    expect(ev).toBeTruthy();
    const { exploreId, specId, gateId, qaId, featureId } = ev!.payload as Record<string, string>;

    expect(s.getFeature(featureId)).toBeTruthy();
    expect(stageOf(s, exploreId)).toBe('explore');
    expect(s.getTask(exploreId)?.status).toBe('ready');
    expect(stageOf(s, specId)).toBe('spec');
    expect(s.getTask(specId)?.status).toBe('todo');
    expect(stageOf(s, gateId)).toBe('gate');
    expect(s.getTask(gateId)?.status).toBe('blocked');
    expect(s.getTask(gateId)?.systemKind).toBe('pipeline_gate');
    expect(stageOf(s, qaId)).toBe('qa');

    expect(s.childrenOf(exploreId)).toContain(specId);
    expect(s.childrenOf(specId)).toContain(gateId);
    expect(s.childrenOf(gateId)).toContain(qaId);
    s.close();
  });

  it('is a no-op on re-run (idempotent)', () => {
    const s = store();
    const root = s.createTask({ title: 'X', pipelineTemplate: 'full_feature' });
    expandTemplate(root, FULL_FEATURE, s, allRoles);
    const before = s.listTasks().length;
    expandTemplate(s.getTask(root.id)!, FULL_FEATURE, s, allRoles);
    expect(s.listTasks().length).toBe(before);
    s.close();
  });

  it('falls back to quick_fix when a required role profile is missing', () => {
    const s = store();
    const root = s.createTask({ title: 'X', pipelineTemplate: 'full_feature' });
    expandTemplate(root, FULL_FEATURE, s, { hasRole: (r) => r !== 'qa' });
    expect(s.listTasks().some((t) => t.pipelineStage !== null)).toBe(false);
    const ev = s.listEvents(root.id).find((e) => e.kind === PIPELINE_EXPANDED_EVENT);
    expect((ev!.payload as Record<string, unknown>).fallback).toBe('quick_fix');
    s.close();
  });

  it('does not expand quick_fix / inert template', () => {
    const s = store();
    const root = s.createTask({ title: 'X', pipelineTemplate: 'quick_fix' });
    expandTemplate(root, QUICK_FIX, s, allRoles);
    expect(s.listTasks().some((t) => t.pipelineStage !== null)).toBe(false);
    s.close();
  });
});
