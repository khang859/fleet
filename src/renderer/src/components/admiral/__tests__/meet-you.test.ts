import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgencyOnboarding, AgencyRepoRef } from '../../../../../shared/agency';
import { meetQuestion } from '../../../../../shared/agency-meet';
import { MeetKnows, MeetPicks, MeetYou } from '../MeetYou';

/** Meet you: the question shown, its progress, the end step, and the side panel. */

const REPO: AgencyRepoRef = { repoId: '0123456789abcdef', root: '/code/shop', name: 'shop' };

const render = (onboarding: AgencyOnboarding, wide = true): string =>
  renderToStaticMarkup(createElement(MeetYou, { paneId: 'p1', repo: REPO, onboarding, wide }));
const text = (html: string): string => html.replace(/<[^>]+>/g, '');

describe('MeetYou', () => {
  it('asks the first question left, with its progress and the recommended pick first', () => {
    const html = text(
      render({
        setupDoneAt: 1,
        starterDoneAt: null,
        meetDue: true,
        meetLeft: ['prs', 'delivery', 'tests', 'budget', 'checks']
      })
    );
    expect(html).toContain('How should crew open pull requests?');
    expect(html).toContain('1 of 5');
    expect(html).toContain('As drafts · My pick');
    expect(html).toContain('Finish later');
    expect(html).toContain('A few quick questions');
    expect(html).toContain('WHAT I KNOW ABOUT YOU');
  });

  it('asks the You questions of a project that finished the starter questions', () => {
    const html = text(
      render({ setupDoneAt: 1, starterDoneAt: 1, meetDue: true, meetLeft: ['report', 'never'] })
    );
    expect(html).toContain('How should I report to you?');
    expect(html).toContain('1 of 2');
  });

  it('ends a first run with the rules and trust steps, and no progress', () => {
    const html = text(render({ setupDoneAt: 1, starterDoneAt: null, meetDue: true, meetLeft: [] }));
    expect(html).toContain('Finish setup');
    expect(html).toContain('Let Claude Code trust this project');
    expect(html).not.toContain('Finish later');
  });

  it('puts the side panel under the question in a narrow pane', () => {
    const html = render(
      { setupDoneAt: 1, starterDoneAt: null, meetDue: true, meetLeft: ['tests'] },
      false
    );
    expect(html).not.toContain('<aside');
    expect(text(html)).toContain('WHAT I KNOW ABOUT YOU');
  });
});

describe('MeetPicks', () => {
  const picks = (id: 'never' | 'prs', picked: number[]): string =>
    renderToStaticMarkup(
      createElement(MeetPicks, {
        question: meetQuestion(id),
        picked,
        disabled: false,
        onPick: () => undefined
      })
    );

  it('ticks each kept pick of a question that keeps several', () => {
    const html = picks('never', [0, 3]);
    expect(html.match(/lucide-check/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
  });

  it('shows no tick and no pressed state on a one-pick question', () => {
    const html = picks('prs', [0]);
    expect(html).not.toContain('lucide-check');
    expect(html).not.toContain('aria-pressed');
  });
});

describe('MeetKnows', () => {
  it('shows both layers, each line with its source, the last answer marked new', () => {
    const html = text(
      renderToStaticMarkup(
        createElement(MeetKnows, {
          repo: REPO,
          layers: {
            you: '# You\n- Never force push. (from you, 2026-10-18)\n',
            project:
              '# shop\n- Use pnpm. (from CLAUDE.md, 2026-10-18)\n- Open PRs as drafts. (from you, 2026-10-18)\n'
          },
          fresh: ['Open PRs as drafts.']
        })
      )
    );
    expect(html).toContain('Never force push.You told me');
    expect(html).toContain('Use pnpm.Read from CLAUDE.md');
    expect(html).toContain('Open PRs as drafts.New · from your last answer');
    expect(html).toContain('This project · shop');
  });

  it('says when a layer has nothing yet', () => {
    const html = text(
      renderToStaticMarkup(
        createElement(MeetKnows, { repo: REPO, layers: { you: null, project: null }, fresh: [] })
      )
    );
    expect(html.match(/Nothing yet\./g)).toHaveLength(2);
  });
});
