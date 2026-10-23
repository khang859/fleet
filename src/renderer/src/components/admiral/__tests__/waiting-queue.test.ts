import { describe, expect, it } from 'vitest';
import type { AgencySnapshot } from '../../../../../shared/agency';
import type { AgencyJobDetail } from '../../../../../shared/agency-jobs';
import { agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { waitingCount } from '../../../store/agency-store';
import { itemsOf, queueOrder, waitingItems, type WaitingItem } from '../waiting-queue';
import { crew, detail, job, permission, settings, snap, version } from './queue-fixtures';

/** What waits on the client, of each kind, as the Bridge queue and a job sheet read it. */

/**
 * A job with one of everything waiting, and the lobby with a question. Its
 * settings cards never wait on the client.
 */
function busy(): { snapshot: AgencySnapshot; details: Record<number, AgencyJobDetail> } {
  const waiting = job({
    permissionsWaiting: [5, 8],
    crewNeedingYou: 1
  });
  const done = job({ id: 3, state: 'delivered', updatedAt: 60 });
  const snapshot = snap({
    jobs: [waiting, done],
    questions: [
      agencyQuestion({ id: 35, jobId: 2, createdAt: 25 }),
      agencyQuestion({ id: 36, jobId: null, createdAt: 15 }),
      agencyQuestion({ id: 37, jobId: 2, status: 'answered' })
    ],
    settingsCards: [settings(), settings({ id: 6, jobId: 2, at: 45 })]
  });
  const details = {
    2: detail(waiting, {
      versions: [version({ id: 6, status: 'replaced' }), version({ version: 2 })],
      permissions: [
        permission(),
        permission({ id: 8, state: 'in_pane', askedAt: null, expiresAt: null }),
        permission({ id: 3, state: 'allowed' })
      ],
      crew: [crew(), crew({ id: 10, flag: null })]
    }),
    3: detail(done)
  };
  return { snapshot, details };
}

const keys = (items: WaitingItem[]): string[] => items.map((i) => i.key);

describe('waitingItems', () => {
  it('lists each kind once, in the order a job sheet shows them', () => {
    const { snapshot, details } = busy();
    expect(keys(waitingItems(snapshot, details, 2))).toEqual([
      'perm:5',
      'perm:8',
      'q:35',
      'crew:9'
    ]);
    expect(keys(waitingItems(snapshot, details, 3))).toEqual(['delivered:3']);
    expect(keys(waitingItems(snapshot, details, null))).toEqual(['q:36']);
  });

  it('takes every open job and the lobby for the whole project', () => {
    const { snapshot, details } = busy();
    expect(keys(waitingItems(snapshot, details))).toEqual([
      'perm:5',
      'perm:8',
      'q:35',
      'crew:9',
      'delivered:3',
      'q:36'
    ]);
    expect(waitingItems(undefined, details)).toEqual([]);
  });

  it('leaves a delivered job off until its PRs are ready', () => {
    const { snapshot, details } = busy();
    const waiting = snap({
      ...snapshot,
      jobs: snapshot.jobs.map((j) => (j.id === 3 ? { ...j, prsWaiting: true } : j))
    });
    expect(keys(waitingItems(waiting, details, 3))).toEqual([]);
  });

  it('dates a permission from when the client was asked, and lets only a client card expire', () => {
    const { snapshot, details } = busy();
    const [card, inPane] = itemsOf(waitingItems(snapshot, details, 2), 'permission');
    expect(card).toMatchObject({ since: 12, expiresAt: 500, permission: { id: 5 } });
    expect(inPane).toMatchObject({ since: 10, expiresAt: null });
  });

  it('stands a loading row in for what the snapshot says waits, under the same key', () => {
    const { snapshot, details } = busy();
    const loading = waitingItems(snapshot, {}, 2);
    expect(keys(loading)).toEqual(['perm:5', 'perm:8', 'q:35', 'crew:job2-0']);
    expect(itemsOf(loading, 'loading').map((i) => i.what)).toEqual([
      'permission',
      'permission',
      'crew'
    ]);
    expect(itemsOf(waitingItems(snapshot, {}, 3), 'delivered')[0].detail).toBeUndefined();
    expect(waitingItems(snapshot, details, 3)).toHaveLength(1);
  });

  it('leaves out what the client decided and Fleet still holds', () => {
    const { snapshot, details } = busy();
    const held = snap({
      ...snapshot,
      held: [
        { id: 1, jobId: 2, key: 'q:35', label: 'Answered q35', runsAt: 99 },
        { id: 2, jobId: null, key: 'q:36', label: 'Answered q36', runsAt: 99 }
      ]
    });
    const left = keys(waitingItems(held, details));
    expect(left).not.toContain('q:35');
    expect(left).not.toContain('q:36');
    expect(keys(waitingItems(held, {}, 2))).not.toContain('q:35');
  });
});

describe('queueOrder', () => {
  it('puts what expires first, soonest first, then the rest oldest first', () => {
    const { snapshot, details } = busy();
    const items = waitingItems(snapshot, details);
    const soon = { ...items[0], key: 'soon', expiresAt: 100 };
    expect(keys(queueOrder([...items, soon]))).toEqual([
      'soon',
      'perm:5',
      'perm:8',
      'q:36',
      'crew:9',
      'q:35',
      'delivered:3'
    ]);
  });
});

describe('waitingCount', () => {
  it('counts the queue, the same before and after the details load', () => {
    const { snapshot, details } = busy();
    expect(waitingCount(snapshot)).toBe(waitingItems(snapshot, details).length);
    expect(waitingCount(snapshot, 2)).toBe(waitingItems(snapshot, details, 2).length);
    expect(waitingCount(snapshot, null)).toBe(1);
    expect(waitingCount(undefined)).toBe(0);
  });
});
