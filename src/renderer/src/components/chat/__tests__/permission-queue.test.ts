import { describe, it, expect } from 'vitest';
import { permissionView } from '../permission-queue';
import type { PermissionRequestPayload } from '../../../../../shared/chat-permissions';

const req = (id: string): PermissionRequestPayload => ({
  requestId: id,
  streamId: 's',
  tool: 'WebSearch',
  command: `q-${id}`
});

describe('permissionView', () => {
  it('is empty when there are no requests', () => {
    const v = permissionView([], {});
    expect(v.active).toBeNull();
    expect(v.undecidedCount).toBe(0);
    expect(v.more).toBe(0);
    expect(v.queued).toEqual([]);
    expect(v.undecidedIds).toEqual([]);
  });

  it('picks the first request as active and the rest as queued', () => {
    const v = permissionView([req('a'), req('b'), req('c')], {});
    expect(v.active?.requestId).toBe('a');
    expect(v.undecidedCount).toBe(3);
    expect(v.more).toBe(2);
    expect(v.queued.map((r) => r.requestId)).toEqual(['b', 'c']);
    expect(v.undecidedIds).toEqual(['a', 'b', 'c']);
  });

  it('skips decided requests when choosing active and counting', () => {
    const v = permissionView([req('a'), req('b'), req('c')], { a: 'allow-once' });
    expect(v.active?.requestId).toBe('b');
    expect(v.undecidedCount).toBe(2);
    expect(v.more).toBe(1);
    expect(v.queued.map((r) => r.requestId)).toEqual(['c']);
    expect(v.undecidedIds).toEqual(['b', 'c']);
  });

  it('has no active request when all are decided', () => {
    const v = permissionView([req('a'), req('b')], { a: 'deny', b: 'allow-once' });
    expect(v.active).toBeNull();
    expect(v.undecidedCount).toBe(0);
    expect(v.more).toBe(0);
  });
});
