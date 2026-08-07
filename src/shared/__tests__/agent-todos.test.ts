import { describe, it, expect } from 'vitest';
import {
  AGENT_TODO_INSTRUCTIONS,
  TODO_BRIEF_AT,
  TODO_ESCALATE_AT,
  TODO_NUDGE_AT,
  activeItem,
  hasOpenWork,
  nextStreak,
  nextTodoId,
  openCount,
  progressed,
  renderTodoBlock,
  renderTodoBrief,
  renderTodoList,
  settledCount,
  type AgentTodoItem,
  type AgentTodoStatus
} from '../agent-todos';

const item = (id: string, status: AgentTodoStatus, content = `task ${id}`): AgentTodoItem => ({
  id,
  content,
  activeForm: null,
  status
});

/** A list of `n` items, all still to be done. */
const fresh = (n: number): AgentTodoItem[] =>
  Array.from({ length: n }, (_, i) => item(String(i + 1), 'pending'));

/** The same list with item `id` moved to `status`. */
const withStatus = (items: AgentTodoItem[], id: string, status: AgentTodoStatus): AgentTodoItem[] =>
  items.map((it) => (it.id === id ? { ...it, status } : it));

describe('nextTodoId', () => {
  it('starts at 1 and counts up', () => {
    expect(nextTodoId([])).toBe('1');
    expect(nextTodoId(fresh(3))).toBe('4');
  });

  /*
   * The whole scheme rests on nothing ever leaving the list. A cancelled item
   * still occupies its number, so the next one cannot collide with an id the
   * model has already been shown.
   */
  it('does not reuse the number of an item that was cancelled', () => {
    const items = withStatus(fresh(3), '2', 'cancelled');

    expect(nextTodoId(items)).toBe('4');
  });
});

describe('hasOpenWork', () => {
  it('is false for an empty list and for one that is entirely settled', () => {
    expect(hasOpenWork([])).toBe(false);
    expect(hasOpenWork([item('1', 'completed'), item('2', 'cancelled')])).toBe(false);
  });

  it('is true while anything is pending or in progress', () => {
    expect(hasOpenWork([item('1', 'completed'), item('2', 'pending')])).toBe(true);
    expect(hasOpenWork([item('1', 'in_progress')])).toBe(true);
  });
});

describe('activeItem and settledCount', () => {
  it('finds the one item being worked on', () => {
    const items = [item('1', 'completed'), item('2', 'in_progress'), item('3', 'pending')];

    expect(activeItem(items)?.id).toBe('2');
    expect(activeItem(fresh(2))).toBeNull();
  });

  it('counts cancelled work as settled, because it is no longer waiting', () => {
    expect(
      settledCount([item('1', 'completed'), item('2', 'cancelled'), item('3', 'pending')])
    ).toBe(2);
  });
});

describe('progressed', () => {
  it('is true when an item finishes', () => {
    const before = fresh(2);

    expect(progressed(before, withStatus(before, '1', 'completed'))).toBe(true);
    expect(progressed(before, withStatus(before, '1', 'cancelled'))).toBe(true);
  });

  it('is true when the work turns up something new to do', () => {
    expect(progressed(fresh(2), [...fresh(2), item('3', 'pending')])).toBe(true);
  });

  /*
   * The case the whole design turns on. A model that would rather not do the
   * work can always change *something*, so starting an item cannot count - it
   * is reversible, and a check that accepted it would be defeated by flipping
   * one item back and forth forever.
   */
  it('is false for starting an item, so oscillation cannot fake it', () => {
    const idle = fresh(2);
    const started = withStatus(idle, '1', 'in_progress');

    expect(progressed(idle, started)).toBe(false);
    expect(progressed(started, idle)).toBe(false);
  });

  it('is false when nothing at all changed', () => {
    expect(progressed(fresh(3), fresh(3))).toBe(false);
  });
});

describe('nextStreak', () => {
  it('climbs while the list sits still', () => {
    const items = fresh(2);

    expect(nextStreak(0, items, items)).toBe(1);
    expect(nextStreak(5, items, items)).toBe(6);
  });

  it('resets when something finishes', () => {
    const before = fresh(2);

    expect(nextStreak(9, before, withStatus(before, '1', 'completed'))).toBe(0);
  });

  it('keeps climbing across an oscillating pair of rounds', () => {
    const idle = fresh(2);
    const started = withStatus(idle, '1', 'in_progress');

    let streak = 0;
    for (let round = 0; round < 8; round++) {
      streak = nextStreak(
        streak,
        round % 2 === 0 ? idle : started,
        round % 2 === 0 ? started : idle
      );
    }

    expect(streak).toBe(8);
  });

  /*
   * A list whose work is done is not stale, it is finished. Left counting, it
   * would eventually start telling the model off about a plan it completed.
   */
  it('is zero once nothing is left open', () => {
    const done = [item('1', 'completed'), item('2', 'cancelled')];

    expect(nextStreak(20, fresh(2), done)).toBe(0);
  });
});

describe('renderTodoList', () => {
  it('gives each item its id and a mark for its state', () => {
    const items = [
      item('1', 'completed', 'read the file'),
      item('2', 'in_progress', 'change it'),
      item('3', 'pending', 'run the tests'),
      item('4', 'cancelled', 'update the docs')
    ];

    expect(renderTodoList(items)).toBe(
      [
        '1. [x] read the file',
        '2. [~] change it',
        '3. [ ] run the tests',
        '4. [-] update the docs'
      ].join('\n')
    );
  });
});

describe('openCount', () => {
  it('counts only what is still to be done, which is what the cap is about', () => {
    const items = [
      item('1', 'completed'),
      item('2', 'cancelled'),
      item('3', 'pending'),
      item('4', 'in_progress')
    ];

    expect(openCount(items)).toBe(2);
    expect(openCount([])).toBe(0);
  });
});

describe('renderTodoBrief', () => {
  /*
   * Under the threshold nothing is gained by summarizing, and the model is
   * better off reading the whole plan.
   */
  it('prints a short list in full', () => {
    const items = [item('1', 'completed', 'read it'), item('2', 'pending', 'change it')];

    expect(renderTodoBrief(items)).toBe(renderTodoList(items));
  });

  it('folds a long run of finished work into one line naming its range', () => {
    const items = [
      ...Array.from({ length: TODO_BRIEF_AT }, (_, i) => item(String(i + 1), 'completed')),
      item(String(TODO_BRIEF_AT + 1), 'in_progress', 'change it')
    ];

    expect(renderTodoBrief(items)).toBe(
      [
        `1-${TODO_BRIEF_AT}. ${TODO_BRIEF_AT} items finished or cancelled.`,
        `13. [~] change it`
      ].join('\n')
    );
  });

  /*
   * The whole point of the elision is that the model can still act on the list.
   * Open items are the ids it has to quote back, so they are never the ones
   * left out.
   */
  it('never summarizes open work, however long the list', () => {
    const items = [
      ...Array.from({ length: 20 }, (_, i) => item(String(i + 1), 'completed')),
      item('21', 'pending', 'change it'),
      item('22', 'pending', 'test it')
    ];
    const brief = renderTodoBrief(items);

    expect(brief).toContain('21. [ ] change it');
    expect(brief).toContain('22. [ ] test it');
  });

  it('keeps finished work that is not in a run, so a lone item is still itself', () => {
    const items = [
      item('1', 'completed', 'read it'),
      ...Array.from({ length: TODO_BRIEF_AT }, (_, i) => item(String(i + 2), 'pending'))
    ];

    expect(renderTodoBrief(items)).toContain('1. [x] read it');
  });
});

describe('renderTodoBlock', () => {
  it('asks for a list when there is none, without insisting on one', () => {
    const block = renderTodoBlock([], 0);

    expect(block).toContain('todo_add');
    expect(block).toContain('ignore this');
  });

  /*
   * The block rides on every round of a turn, so a list that has been worked
   * all the way through has to stop paying for itself.
   */
  it('says nothing once every item is settled', () => {
    expect(renderTodoBlock([item('1', 'completed'), item('2', 'cancelled')], 0)).toBeNull();
  });

  it('shows the list itself whenever there is open work', () => {
    const block = renderTodoBlock([item('1', 'in_progress', 'change it')], 0);

    expect(block).toContain('1. [~] change it');
  });

  it('is matter-of-fact while the list is moving', () => {
    const block = renderTodoBlock(fresh(2), TODO_NUDGE_AT - 1);

    expect(block).toContain('Keep this current');
    expect(block).not.toContain('rounds');
  });

  /*
   * A user changing their mind does it in a fresh turn, where the streak has
   * just reset - so the bottom rung is the only one a superseded plan ever
   * sees, and it has to be the one that says the plan may be struck off.
   */
  it('allows for a plan the user has abandoned at the bottom rung', () => {
    expect(renderTodoBlock(fresh(2), 0)).toContain('cancel anything the user has since moved on');
  });

  it('points at the item it has been stuck on once the streak is long enough', () => {
    const items = withStatus(fresh(2), '2', 'in_progress');
    const block = renderTodoBlock(items, TODO_NUDGE_AT);

    expect(block).toContain(`${TODO_NUDGE_AT} rounds`);
    expect(block).toContain('`2`');
  });

  /*
   * The escape hatch a nagged model reaches for first: call the tool, change
   * nothing, and the pressure goes away. Saying so up front is cheaper than
   * detecting it after the fact.
   */
  it('rules out calling the tools for their own sake', () => {
    expect(renderTodoBlock(fresh(2), TODO_NUDGE_AT)).toContain('is not progress');
  });

  it('gets firm at the top rung, and offers being stuck as a way out', () => {
    const block = renderTodoBlock(fresh(2), TODO_ESCALATE_AT);

    expect(block).toContain(`${TODO_ESCALATE_AT} rounds`);
    expect(block).toContain('stuck');
  });
});

describe('AGENT_TODO_INSTRUCTIONS', () => {
  it('names both tools and the rule the tool code enforces', () => {
    expect(AGENT_TODO_INSTRUCTIONS).toContain('todo_add');
    expect(AGENT_TODO_INSTRUCTIONS).toContain('todo_update');
    expect(AGENT_TODO_INSTRUCTIONS).toContain('Only one item is `in_progress`');
  });

  /*
   * The pane already shows the list. A model that also narrates it turns every
   * reply into a duplicate of what is on screen beside it.
   */
  it('tells the model the user can already see the list', () => {
    expect(AGENT_TODO_INSTRUCTIONS).toContain('do not read it back to them');
  });
});
