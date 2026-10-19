import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencySnapshot } from '../../../../../shared/agency';
import type { AgencyJobDetail } from '../../../../../shared/agency-jobs';
import { PlanSchema } from '../../../../../shared/agency-plan';
import { agencyQuestion } from '../../../../../shared/__tests__/agency-fixtures';
import { QueueReader } from '../QueueReader';
import { queueOrder, waitingItems } from '../waiting-queue';
import {
  bridgeQueue,
  crew,
  detail,
  job,
  permission,
  PLAN,
  settings,
  snap,
  version
} from './queue-fixtures';

/** The Bridge reader: a queue item in full in the main column. */

/** j2 with a permission request and a plan, a lobby question, and a settings card. */
function queue(): { snapshot: AgencySnapshot; details: Record<number, AgencyJobDetail> } {
  const planned = job({
    title: 'Get PR #61 to green CI',
    brief: 'Get PR #61 to green CI, and do not touch main.',
    pendingPlan: { id: 7, version: 1 },
    permissionsWaiting: [5]
  });
  return {
    snapshot: snap({
      jobs: [planned],
      questions: [
        agencyQuestion({
          id: 35,
          jobId: null,
          question: 'Which PRs first?',
          context: 'Both are red. #58 fails lint.',
          options: [{ label: '#58 first', detail: 'Lint only' }, { label: 'Both at once' }],
          recommended: 1,
          createdAt: 40
        })
      ],
      settingsCards: [settings({ at: 60 })]
    }),
    details: {
      2: detail(planned, {
        versions: [version()],
        permissions: [permission({ target: 'git push --force-with-lease origin fix/pr-61' })],
        crew: [crew({ flag: null })]
      })
    }
  };
}

const read = (key: string, over: Partial<ReturnType<typeof queue>> = {}): string => {
  const { snapshot, details } = { ...queue(), ...over };
  const items = queueOrder(waitingItems(snapshot, details));
  return renderToStaticMarkup(
    createElement(QueueReader, {
      items,
      reading: { key, index: items.findIndex((i) => i.key === key) },
      snapshot,
      refused: [],
      onRead: () => {},
      onOpenSettings: () => {}
    })
  );
};

/** The markup before and after the reader's footer, which stays out of the scrolling part. */
function split(html: string): [string, string] {
  const at = html.indexOf('border-t border-fleet-border bg-fleet-surface');
  expect(at).toBeGreaterThan(0);
  return [html.slice(0, at), html.slice(at)];
}

describe('the Bridge reader', () => {
  it('names the item and its place in the queue, with Previous, Next and Close', () => {
    const html = read('plan:7');
    expect(html).toContain('aria-label="Reading plan v1"');
    expect(html).toContain('>PLAN v1<');
    expect(html).toContain('Get PR #61 to green CI');
    expect(html).toContain('2 of 4 waiting');
    expect(html).toMatch(/aria-label="Previous" title="Previous \(K\)" data-key="previous"/);
    expect(html).toMatch(/aria-label="Next"/);
    expect(html).toMatch(/aria-label="Close"/);

    const first = read('perm:5');
    expect(first).toContain('1 of 4 waiting');
    expect(first).toMatch(/aria-label="Previous"[^>]*disabled=""/);
  });

  it('shows a long plan in full, with its decision in a footer out of the scroll', () => {
    const long = PlanSchema.parse({
      ...PLAN,
      steps: Array.from({ length: 9 }, (_, i) => ({
        id: `builder-${i + 1}`,
        role: 'builder',
        title: `Step number ${i + 1}`,
        skills: i === 8 ? ['vitest'] : [],
        after: i === 8 ? ['builder-1'] : [],
        cap: i === 8 ? { turns: 40 } : undefined
      })),
      budget: { usd: 8, weekPct: 12 }
    });
    const { snapshot, details } = queue();
    details[2].versions = [version({ plan: long })];
    const [content, footer] = split(read('plan:7', { snapshot, details }));
    expect(content).toContain('Get PR #61 to green CI, and do not touch main.');
    for (let i = 1; i <= 9; i++) expect(content).toContain(`Step number ${i}`);
    expect(content).toMatch(/Uses<\/dt><dd[^>]*>vitest/);
    expect(content).toMatch(/Waits on<\/dt><dd[^>]*>step 1/);
    expect(content).toMatch(/Stops at<\/dt><dd[^>]*>40 turns/);
    expect(content).toContain('9 crew members');
    expect(content).toContain('12% Claude week');
    expect(footer).toContain('>Approve plan<');
    expect(footer).toContain('>Change<');
    expect(footer).toContain('>Reject<');
    expect(content).not.toContain('>Approve plan<');
  });

  it('shows a permission request with its full target and the answers in the footer', () => {
    const [content, footer] = split(read('perm:5'));
    expect(content).toContain('git push --force-with-lease origin fix/pr-61');
    expect(content).toContain('It publishes.');
    expect(content).toContain('Peek at the pane');
    expect(footer).toContain('>Allow once');
    expect(footer).toContain('Deny and say why');
  });

  it("shows a question's context and every option, with the Admiral's pick ticked", () => {
    const [content, footer] = split(read('q:35'));
    expect(content).toContain('Both are red. #58 fails lint.');
    expect(content).toContain('Lint only');
    expect(content).toMatch(/Both at once<span[^>]*> · My pick<\/span>/);
    // The pick is ticked; the other option is not.
    expect(content.match(/checked=""/g)).toHaveLength(1);
    expect(content.indexOf('checked=""')).toBeGreaterThan(content.indexOf('#58 first'));
    expect(content).toContain('IN YOUR OWN WORDS');
    expect(footer).toMatch(/<button type="button" class="[^"]*"[^>]*>Answer<kbd/);
  });

  it('shows the other kinds as their cards at full width', () => {
    const html = read('settings:4');
    expect(html).toContain('aria-label="Settings');
    expect(html).toContain('max-w-[760px]');
  });

  it('marks the card it shows in the queue, and offers Read on the others', () => {
    const { snapshot, details } = queue();
    const html = bridgeQueue(snapshot, details, [], 'plan:7');
    expect(html.match(/>READING</g)).toHaveLength(1);
    expect(html.indexOf('>READING<')).toBeGreaterThan(html.indexOf('>PLAN v1<'));
    expect(html.match(/aria-label="Read in full"/g)).toHaveLength(3);
    expect(html).toContain('ring-2 ring-blue-400/50');
  });
});
