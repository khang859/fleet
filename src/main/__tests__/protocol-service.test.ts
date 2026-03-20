import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StarbaseDB } from '../starbase/db';
import { ProtocolService } from '../starbase/protocol-service';
import { rmSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_DIR = join(tmpdir(), 'fleet-test-protocol-service');
let db: StarbaseDB;
let svc: ProtocolService;

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  db = new StarbaseDB('/tmp/protocol-test', join(TEST_DIR, 'starbases'));
  db.open();
  svc = new ProtocolService(db.getDb());
});

afterEach(() => {
  db.close();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('ProtocolService', () => {
  describe('protocols', () => {
    it('lists all protocols', () => {
      const rows = svc.listProtocols();
      expect(Array.isArray(rows)).toBe(true);
    });

    it('creates and retrieves a protocol by slug', () => {
      svc.createProtocol({
        id: 'proto-1',
        slug: 'test-research-deploy',
        name: 'Research and Deploy',
        description: 'Research then build',
        helpText: null,
        triggerExamples: ['build me X'],
        builtIn: false,
      });
      const p = svc.getProtocolBySlug('test-research-deploy');
      expect(p?.name).toBe('Research and Deploy');
      expect(p?.slug).toBe('test-research-deploy');
    });

    it('enables and disables a protocol', () => {
      svc.createProtocol({ id: 'proto-2', slug: 'test-proto', name: 'Test', description: null, helpText: null, triggerExamples: [], builtIn: false });
      svc.setProtocolEnabled('test-proto', false);
      expect(svc.getProtocolBySlug('test-proto')?.enabled).toBe(0);
      svc.setProtocolEnabled('test-proto', true);
      expect(svc.getProtocolBySlug('test-proto')?.enabled).toBe(1);
    });

    it('throws when enabling non-existent protocol', () => {
      expect(() => svc.setProtocolEnabled('no-such', true)).toThrow();
    });
  });

  describe('protocol_steps', () => {
    it('adds and lists steps for a protocol', () => {
      svc.createProtocol({ id: 'proto-3', slug: 'with-steps', name: 'With Steps', description: null, helpText: null, triggerExamples: [], builtIn: false });
      svc.addStep('proto-3', { stepOrder: 1, type: 'deploy-crew', config: { mission: 'research' }, description: 'Deploy research crew' });
      svc.addStep('proto-3', { stepOrder: 2, type: 'gate', config: {}, description: 'Gate' });
      const steps = svc.listSteps('proto-3');
      expect(steps).toHaveLength(2);
      expect(steps[0].type).toBe('deploy-crew');
      expect(steps[1].type).toBe('gate');
    });
  });

  describe('protocol_executions', () => {
    it('creates and retrieves an execution', () => {
      svc.createProtocol({ id: 'proto-4', slug: 'exec-proto', name: 'Exec Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-4', featureRequest: 'build auth' });
      const exec = svc.getExecution(id);
      expect(exec?.status).toBe('running');
      expect(exec?.current_step).toBe(1);
      expect(exec?.feature_request).toBe('build auth');
    });

    it('advances step and validates guard', () => {
      svc.createProtocol({ id: 'proto-5', slug: 'step-proto', name: 'Step Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-5', featureRequest: 'test' });
      svc.advanceStep(id, 2);
      expect(svc.getExecution(id)?.current_step).toBe(2);
      expect(() => svc.advanceStep(id, 4)).toThrow();
    });

    it('updates execution status', () => {
      svc.createProtocol({ id: 'proto-6', slug: 'status-proto', name: 'Status Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-6', featureRequest: 'test' });
      svc.updateExecutionStatus(id, 'gate-pending');
      expect(svc.getExecution(id)?.status).toBe('gate-pending');
    });

    it('lists stale gate-pending executions', () => {
      svc.createProtocol({ id: 'proto-7', slug: 'stale-proto', name: 'Stale Proto', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-7', featureRequest: 'test' });
      svc.updateExecutionStatus(id, 'gate-pending');
      db.getDb().prepare(`UPDATE protocol_executions SET updated_at = datetime('now', '-2 days') WHERE id = ?`).run(id);
      const stale = svc.getStaleGatePendingExecutions(3600);
      expect(stale.some(e => e.id === id)).toBe(true);
    });

    it('updates execution context', () => {
      svc.createProtocol({ id: 'proto-8', slug: 'ctx-proto', name: 'Ctx', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-8', featureRequest: 'test' });
      svc.updateExecutionContext(id, 'some context');
      expect(svc.getExecution(id)?.context).toBe('some context');
    });

    it('updates active crew ids', () => {
      svc.createProtocol({ id: 'proto-9', slug: 'crew-proto', name: 'Crew', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id = svc.createExecution({ protocolId: 'proto-9', featureRequest: 'test' });
      svc.updateActiveCrewIds(id, ['crew-1', 'crew-2']);
      expect(svc.getExecution(id)?.active_crew_ids).toBe('["crew-1","crew-2"]');
    });

    it('lists executions filtered by status', () => {
      svc.createProtocol({ id: 'proto-10', slug: 'filter-proto', name: 'Filter', description: null, helpText: null, triggerExamples: [], builtIn: false });
      const id1 = svc.createExecution({ protocolId: 'proto-10', featureRequest: 'test1' });
      const id2 = svc.createExecution({ protocolId: 'proto-10', featureRequest: 'test2' });
      svc.updateExecutionStatus(id2, 'complete');
      const running = svc.listExecutions('running');
      expect(running.some(e => e.id === id1)).toBe(true);
      expect(running.some(e => e.id === id2)).toBe(false);
    });

    it('throws on updateExecutionStatus with missing id', () => {
      expect(() => svc.updateExecutionStatus('no-such', 'complete')).toThrow();
    });
  });
});
