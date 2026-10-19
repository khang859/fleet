import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueKey } from '../queue-keys';
import { bridgeQueue, detail, job, permission, snap, version } from './queue-fixtures';

/** The Bridge's keys: what each does, and where they do nothing. */

/** Stands in for a DOM element: `inText` says whether it sits in a text field. */
class FakeElement extends EventTarget {
  constructor(private readonly inText: boolean) {
    super();
  }
  closest(): FakeElement | null {
    return this.inText ? this : null;
  }
}

const press = (over: Partial<Parameters<typeof queueKey>[0]>): ReturnType<typeof queueKey> =>
  queueKey({
    key: 'a',
    target: null,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    defaultPrevented: false,
    ...over
  });

describe('the Bridge keys', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('maps J, K, Enter, Esc, A, D, C and R, and nothing else', () => {
    expect(['j', 'k', 'Enter', 'Escape', 'a', 'd', 'c', 'r'].map((key) => press({ key }))).toEqual([
      'next',
      'previous',
      'read',
      'close',
      'approve',
      'deny',
      'change',
      'reply'
    ]);
    expect(press({ key: 'x' })).toBeNull();
    expect(press({ key: 'A' })).toBeNull();
  });

  it('leaves a letter typed in the composer to the composer', () => {
    vi.stubGlobal('Element', FakeElement);
    expect(press({ target: new FakeElement(true) })).toBeNull();
    expect(press({ key: 'Escape', target: new FakeElement(true) })).toBeNull();
    expect(press({ target: new FakeElement(false) })).toBe('approve');
  });

  it('does nothing with a modifier held, or once something else took the key', () => {
    expect(press({ metaKey: true })).toBeNull();
    expect(press({ ctrlKey: true })).toBeNull();
    expect(press({ altKey: true })).toBeNull();
    expect(press({ shiftKey: true })).toBeNull();
    expect(press({ defaultPrevented: true })).toBeNull();
  });

  it('marks the buttons each key presses, and puts one card at a time in the tab order', () => {
    const planned = job({ pendingPlan: { id: 7, version: 1 }, permissionsWaiting: [5] });
    const html = bridgeQueue(snap({ jobs: [planned] }), {
      2: detail(planned, { versions: [version()], permissions: [permission()] })
    });
    expect(html).toContain('data-queue-scope="queue"');
    expect(html).toMatch(/data-item="perm:5" tabindex="0"/);
    expect(html).toMatch(/data-item="plan:7" tabindex="-1"/);
    expect(html).toMatch(/data-key="approve" aria-keyshortcuts="A">Allow once/);
    expect(html).toMatch(/data-key="deny" aria-keyshortcuts="D">Deny/);
    expect(html).toMatch(/data-key="approve" aria-keyshortcuts="A">Approve plan/);
    expect(html).toMatch(/data-key="change" aria-keyshortcuts="C">Change/);
    expect(html).toMatch(/data-key="deny" aria-keyshortcuts="D">Reject/);
    expect(html).toContain(
      '<kbd class="font-sans font-medium text-fleet-text-muted">J K</kbd> move'
    );
  });
});
