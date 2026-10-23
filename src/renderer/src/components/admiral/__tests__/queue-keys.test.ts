import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueKey } from '../queue-keys';
import { agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { bridgeQueue, detail, job, permission, snap } from './queue-fixtures';

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

  it('maps J, K, Enter, Esc, A, D and R, and nothing else', () => {
    expect(['j', 'k', 'Enter', 'Escape', 'a', 'd', 'r'].map((key) => press({ key }))).toEqual([
      'next',
      'previous',
      'read',
      'close',
      'approve',
      'deny',
      'reply'
    ]);
    expect(press({ key: 'x' })).toBeNull();
    expect(press({ key: 'c' })).toBeNull();
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
    const asking = job({ permissionsWaiting: [5] });
    const html = bridgeQueue(
      snap({ jobs: [asking], questions: [agencyQuestion({ id: 35, jobId: 2, createdAt: 40 })] }),
      { 2: detail(asking, { permissions: [permission()] }) }
    );
    expect(html).toContain('data-queue-scope="queue"');
    expect(html).toMatch(/data-item="perm:5" tabindex="0"/);
    expect(html).toMatch(/data-item="q:35" tabindex="-1"/);
    expect(html).toMatch(/data-key="approve" aria-keyshortcuts="A">Allow once/);
    expect(html).toMatch(/data-key="deny" aria-keyshortcuts="D">Deny/);
    expect(html).toMatch(/data-key="reply" aria-keyshortcuts="R"/);
    expect(html).not.toContain('data-key="change"');
    expect(html).toContain(
      '<kbd class="font-sans font-medium text-fleet-text-muted">J K</kbd> move'
    );
  });
});
