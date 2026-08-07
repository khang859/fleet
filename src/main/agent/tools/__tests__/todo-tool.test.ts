import { describe, it, expect, beforeEach } from 'vitest';
import type { AgentToolContext } from '../../../../shared/agent-tools';
import { TODO_MAX_ITEMS, type AgentTodoItem } from '../../../../shared/agent-todos';
import { runTodoAdd, runTodoUpdate } from '../todo';

/** The turn-local list the tools read and write, as the service would hold it. */
let items: AgentTodoItem[];

beforeEach(() => {
  items = [];
});

const ctx = (): AgentToolContext => ({
  cwd: '/tmp/nowhere',
  threadId: '11111111-2222-4333-8444-555555555555',
  signal: new AbortController().signal,
  handOff: () => {},
  approve: async () => Promise.resolve(true),
  wasRefused: () => false,
  generateImage: null,
  mcp: null,
  todos: {
    list: () => items,
    save: (next) => {
      items = next;
    }
  }
});

/** Adds `n` throwaway tasks and returns the list. */
const plan = (n: number): AgentTodoItem[] => {
  runTodoAdd({ items: Array.from({ length: n }, (_, i) => ({ content: `task ${i + 1}` })) }, ctx());
  return items;
};

describe('todo_add', () => {
  it('numbers a plan written in one call in the order it was written', () => {
    const result = runTodoAdd(
      {
        items: [
          { content: 'read the file', activeForm: 'Reading the file' },
          { content: 'change it' },
          { content: 'run the tests' }
        ]
      },
      ctx()
    );

    expect(items.map((it) => it.id)).toEqual(['1', '2', '3']);
    expect(items.every((it) => it.status === 'pending')).toBe(true);
    expect(result.summary).toBe('+3');
    // The whole list comes back, so the model never has to remember the numbers.
    expect(result.text).toContain('1. [ ] read the file');
    expect(result.text).toContain('3. [ ] run the tests');
    expect(result.todos).toEqual(items);
  });

  it('keeps the present-continuous form when there is one, and null when there is not', () => {
    runTodoAdd(
      { items: [{ content: 'change it', activeForm: 'Changing it' }, { content: 'ship' }] },
      ctx()
    );

    expect(items[0].activeForm).toBe('Changing it');
    expect(items[1].activeForm).toBeNull();
  });

  it('carries on numbering from an existing list', () => {
    plan(2);
    runTodoAdd({ items: [{ content: 'and one more' }] }, ctx());

    expect(items.map((it) => it.id)).toEqual(['1', '2', '3']);
  });

  /*
   * Refusing the whole call rather than taking what fits: a partial add leaves
   * the model believing it planned something it did not, which is the one
   * failure this list exists to prevent.
   */
  it('adds nothing at all when the list would go over its limit', () => {
    plan(TODO_MAX_ITEMS - 1);

    expect(() => runTodoAdd({ items: [{ content: 'a' }, { content: 'b' }] }, ctx())).toThrow(
      /room for 1 more/
    );
    expect(items).toHaveLength(TODO_MAX_ITEMS - 1);
  });

  /*
   * The limit is on how much is outstanding, not on how much a session may ever
   * get through. Against the whole list it would be unrecoverable: nothing is
   * ever removed, so a session that finished fifty things would be refused a
   * fifty-first and told to finish what it already had.
   */
  it('counts the limit against unfinished work, so getting things done makes room', () => {
    plan(TODO_MAX_ITEMS);
    for (const item of [...items]) {
      runTodoUpdate({ id: item.id, status: 'completed' }, ctx());
    }

    expect(() => runTodoAdd({ items: [{ content: 'the next job' }] }, ctx())).not.toThrow();
    expect(items).toHaveLength(TODO_MAX_ITEMS + 1);
    expect(items.at(-1)?.id).toBe(String(TODO_MAX_ITEMS + 1));
  });

  it('still refuses when that many things are genuinely outstanding', () => {
    plan(TODO_MAX_ITEMS);

    expect(() => runTodoAdd({ items: [{ content: 'one more' }] }, ctx())).toThrow(/is the limit/);
  });
});

describe('todo_update', () => {
  it('moves one task and leaves the rest alone', () => {
    plan(3);
    const result = runTodoUpdate({ id: '2', status: 'in_progress' }, ctx());

    expect(items.map((it) => it.status)).toEqual(['pending', 'in_progress', 'pending']);
    expect(result.text).toContain('2. [~] task 2');
    expect(result.todos).toEqual(items);
  });

  it('counts what is settled in the summary, cancelled included', () => {
    plan(4);
    runTodoUpdate({ id: '1', status: 'completed' }, ctx());
    const result = runTodoUpdate({ id: '2', status: 'cancelled' }, ctx());

    expect(result.summary).toBe('2/4 done');
  });

  it('can rewrite a task that turned out to be something else', () => {
    plan(1);
    runTodoUpdate({ id: '1', status: 'in_progress', content: 'actually move the parser' }, ctx());

    expect(items[0].content).toBe('actually move the parser');
  });

  /*
   * The one rule the tool enforces rather than asks for. Everything else about
   * keeping the list honest is a matter of pressure applied round by round;
   * this one is checkable, so it is checked.
   */
  it('refuses a second task in progress, and names the one already running', () => {
    plan(2);
    runTodoUpdate({ id: '1', status: 'in_progress' }, ctx());

    expect(() => runTodoUpdate({ id: '2', status: 'in_progress' }, ctx())).toThrow(
      /Task 1 \(task 1\) is already in progress/
    );
    expect(items[1].status).toBe('pending');
  });

  it('allows re-stating the task that is already running', () => {
    plan(2);
    runTodoUpdate({ id: '1', status: 'in_progress' }, ctx());

    expect(() => runTodoUpdate({ id: '1', status: 'in_progress' }, ctx())).not.toThrow();
  });

  /*
   * Never refused: between finishing one task and starting the next there is
   * genuinely nothing in progress, and a list that insisted otherwise would be
   * making the model lie to satisfy it.
   */
  it('allows nothing to be in progress', () => {
    plan(2);
    runTodoUpdate({ id: '1', status: 'in_progress' }, ctx());
    runTodoUpdate({ id: '1', status: 'completed' }, ctx());

    expect(items.some((it) => it.status === 'in_progress')).toBe(false);
  });

  it('shows the list when the number does not exist, so the next call can be right', () => {
    plan(2);

    expect(() => runTodoUpdate({ id: '9', status: 'completed' }, ctx())).toThrow(
      /1\. \[ \] task 1/
    );
  });

  it('points at todo_add when there is no list at all', () => {
    expect(() => runTodoUpdate({ id: '1', status: 'completed' }, ctx())).toThrow(/todo_add/);
  });
});
