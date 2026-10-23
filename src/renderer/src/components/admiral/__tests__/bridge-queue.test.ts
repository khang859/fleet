import { describe, expect, it } from 'vitest';
import type { AgencySnapshot, ClientDecision } from '../../../../../shared/agency';
import type { AgencyJobDetail } from '../../../../../shared/agency-jobs';
import { agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { bridgeQueue, detail, job, permission, snap, version } from './queue-fixtures';

/** The Bridge's right-hand column, in each state the client can find it in. */

const queue = bridgeQueue;

/** Two open jobs: j2 with a permission request, j3 with a question. */
function twoJobs(over: Partial<AgencySnapshot> = {}): {
  snapshot: AgencySnapshot;
  details: Record<number, AgencyJobDetail>;
} {
  const planned = job({ title: 'Get PR #61 to green CI', permissionsWaiting: [5] });
  const asking = job({ id: 3, title: 'Get the other two PRs to green CI', state: 'running' });
  return {
    snapshot: snap({
      jobs: [planned, asking],
      questions: [agencyQuestion({ id: 35, jobId: 3, question: 'Which PRs?', createdAt: 40 })],
      ...over
    }),
    details: {
      2: detail(planned, { versions: [version()], permissions: [permission()] }),
      3: detail(asking)
    }
  };
}

describe('the Bridge queue', () => {
  it('lists what waits across jobs, soonest to expire first, each with its kind and job', () => {
    const { snapshot, details } = twoJobs();
    const html = queue(snapshot, details);
    expect(html).toContain('aria-label="Waiting on you"');
    expect(html).toContain('WAITING ON YOU · 2');
    const order = ['>PERMISSION<', '>QUESTION<'].map((s) => html.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('Get PR #61 to green CI');
    expect(html).toContain('Get the other two PRs to green CI');
    expect(html).toContain('>Allow once');
    expect(html).toContain('Which PRs?');
    expect(html).not.toContain('Nothing waits on you');
  });

  it('stands a one-line row in for an item whose job detail is still loading', () => {
    const { snapshot } = twoJobs();
    const html = queue(snapshot);
    expect(html).toContain('WAITING ON YOU · 2');
    expect(html.match(/aria-busy="true"/g)).toHaveLength(1);
    expect(html).not.toContain('>Allow once');
  });

  it('stays empty while a job runs with nothing to ask', () => {
    const running = job({ id: 4, state: 'running' });
    const html = queue(snap({ jobs: [running] }), {
      4: detail(running, { versions: [version()] })
    });
    expect(html).toContain('WAITING ON YOU · 0');
    expect(html).toContain('Nothing waits on you');
    expect(html).not.toContain('>PLAN');
  });

  it('shows a held decision as one line with Undo in place of its card', () => {
    const { snapshot, details } = twoJobs({
      held: [{ id: 4, jobId: 3, key: 'q:35', label: 'Answered q35', runsAt: Date.now() + 5000 }]
    });
    const html = queue(snapshot, details);
    expect(html).toContain('WAITING ON YOU · 1');
    expect(html).not.toContain('>QUESTION<');
    expect(html).toMatch(/Answered q35<span> · <span[^>]*>j3<\/span><\/span>/);
    expect(html).toMatch(/>Undo · [45]s</);
  });

  it('says why a decision was refused, on its card or as its own line once the item is gone', () => {
    const { snapshot, details } = twoJobs();
    const html = queue(snapshot, details, [
      { key: 'q:35', jobId: 3, label: 'Answer q35', reason: 'q35 is already answered.' },
      { key: 'q:6', jobId: 2, label: 'Answer q6', reason: 'q6 was withdrawn.' }
    ]);
    expect(html).toContain('Answer q35 did not go through: q35 is already answered.');
    expect(html).toContain('Answer q6 did not go through: q6 was withdrawn.');
    // The question's refusal sits in its card, after the card's kind.
    expect(html.indexOf('>QUESTION<')).toBeLessThan(html.indexOf('Answer q35 did not'));
    expect(html.indexOf('Answer q6 did not')).toBeLessThan(html.indexOf('>PERMISSION<'));
  });

  it("says nothing waits once the queue is empty, and lists today's decisions with where each job is", () => {
    const decision = (over: Partial<ClientDecision>): ClientDecision => ({
      key: 'q:35',
      jobId: 3,
      label: 'Answered q35',
      detail: '#58 and #63',
      jobState: 'running',
      at: 1,
      ...over
    });
    const html = queue(
      snap({
        jobs: [job({ id: 3, state: 'running' })],
        decisions: [
          decision({}),
          decision({ key: 'q:2', label: 'Answered q2', detail: null, jobState: 'closed' }),
          decision({ key: 'q:9', jobId: null, label: 'Answered q9', detail: 'Yes', jobState: null })
        ]
      })
    );
    expect(html).toContain('WAITING ON YOU · 0');
    expect(html).toContain('Nothing waits on you');
    expect(html).toContain('DONE TODAY');
    expect(html).toMatch(
      /Answered q35<span[^>]*> · #58 and #63<\/span><\/span><span class="[^"]*shrink-0[^"]*">· <span[^>]*>j3<\/span><\/span>/
    );
    expect(html).toContain('>Working<');
    expect(html).toContain('>Closed<');
    expect(html).toMatch(/Answered q9<span[^>]*> · Yes<\/span><\/span><\/li>/);
    expect(html).not.toContain('All 3');

    const many = Array.from({ length: 6 }, (_, i) => decision({ key: `q:${i}` }));
    expect(queue(snap({ decisions: many }))).toContain('>All 6<');
  });

  it('keeps the lobby parts below the queue: past jobs and the default budget', () => {
    const past = [job({ id: 7, title: 'Billing export', state: 'closed' })];
    const html = queue(snap({ jobs: [job()], pastJobs: past }));
    expect(html).toContain('PAST JOBS');
    expect(html).toContain('Billing export');
    expect(html).toContain('Default budget');
    expect(html).not.toContain('HOW A JOB GOES');
    expect(html.indexOf('WAITING ON YOU')).toBeLessThan(html.indexOf('PAST JOBS'));
  });
});
