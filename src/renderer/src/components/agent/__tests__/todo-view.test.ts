import { describe, expect, it } from 'vitest';
import type { AgentTodoItem, AgentTodoStatus } from '../../../../../shared/agent-todos';
import {
  TODO_PANEL_KEEP_PX,
  TODO_PANEL_MIN_PANE_PX,
  showTodoPanel,
  splitTodos,
  todoProgress
} from '../todo-view';

/** The panel is up, the pane is wide, and a turn is running. */
const LIVE = { width: 2000, streaming: true, shown: true };

const item = (
  id: string,
  status: AgentTodoStatus,
  activeForm: string | null = null
): AgentTodoItem => ({ id, content: `task ${id}`, activeForm, status });

describe('todoProgress', () => {
  it('is null for a conversation that never made a list', () => {
    expect(todoProgress([])).toBeNull();
  });

  it('counts settled work, cancelled included, since neither is still waiting', () => {
    const progress = todoProgress([
      item('1', 'completed'),
      item('2', 'cancelled'),
      item('3', 'pending')
    ]);

    expect(progress?.count).toBe('2/3');
    expect(progress?.open).toBe(true);
  });

  it('names what is running in the present continuous', () => {
    expect(todoProgress([item('1', 'in_progress', 'Moving the parser')])?.doing).toBe(
      'Moving the parser'
    );
  });

  /*
   * The model may leave the second form out. Showing the imperative reads
   * slightly wrong; showing nothing while the agent is plainly working reads
   * like it has stopped.
   */
  it('falls back to the plain form when the model wrote only one', () => {
    expect(todoProgress([item('1', 'in_progress')])?.doing).toBe('task 1');
  });

  it('has nothing running between one item and the next', () => {
    expect(todoProgress([item('1', 'completed'), item('2', 'pending')])?.doing).toBeNull();
  });

  it('stays visible with everything done, so the finished list can be read', () => {
    const progress = todoProgress([item('1', 'completed'), item('2', 'completed')]);

    expect(progress?.count).toBe('2/2');
    expect(progress?.open).toBe(false);
  });
});

describe('splitTodos', () => {
  it('puts what is left above what is finished', () => {
    const { open, done } = splitTodos([
      item('1', 'completed'),
      item('2', 'pending'),
      item('3', 'cancelled'),
      item('4', 'in_progress')
    ]);

    expect(open.map((i) => i.id)).toEqual(['4', '2']);
    expect(done.map((i) => i.id)).toEqual(['1', '3']);
  });

  /*
   * The running item answers "what now", which is the question the column is
   * glanced at for - so it goes first even when the model started something
   * out of order and lower-numbered items are still waiting.
   */
  it('lifts the running item above work that was planned earlier', () => {
    const { open } = splitTodos([
      item('1', 'pending'),
      item('2', 'pending'),
      item('3', 'in_progress')
    ]);

    expect(open.map((i) => i.id)).toEqual(['3', '1', '2']);
  });

  it('keeps creation order inside each group rather than order of finishing', () => {
    const { done } = splitTodos([
      item('1', 'completed'),
      item('2', 'pending'),
      item('3', 'completed'),
      item('4', 'cancelled')
    ]);

    expect(done.map((i) => i.id)).toEqual(['1', '3', '4']);
  });

  /*
   * The reordering is the renderer's alone. Ids are minted by position and the
   * model quotes them back, so a stored list sorted into `7. 1. 2.` invites it
   * to answer about the line rather than the item.
   */
  it('leaves the list it was given alone', () => {
    const items = [item('1', 'completed'), item('2', 'in_progress')];
    splitTodos(items);

    expect(items.map((i) => i.id)).toEqual(['1', '2']);
  });
});

describe('showTodoPanel', () => {
  const items = [item('1', 'pending')];

  it('takes a column only when the pane has the room', () => {
    expect(showTodoPanel(items, { ...LIVE, shown: false, width: TODO_PANEL_MIN_PANE_PX })).toBe(
      true
    );
    expect(showTodoPanel(items, { ...LIVE, shown: false, width: TODO_PANEL_MIN_PANE_PX - 1 })).toBe(
      false
    );
  });

  /*
   * A divider is dragged live and lands on fractional widths, so one threshold
   * for both directions flickers a 260px column in and out under the hand.
   */
  it('holds a column it already has down to a lower width', () => {
    const width = TODO_PANEL_MIN_PANE_PX - 10;

    expect(showTodoPanel(items, { ...LIVE, width, shown: true })).toBe(true);
    expect(showTodoPanel(items, { ...LIVE, width, shown: false })).toBe(false);
  });

  it('gives the column up once the pane is genuinely too narrow', () => {
    expect(showTodoPanel(items, { ...LIVE, width: TODO_PANEL_KEEP_PX - 1, shown: true })).toBe(
      false
    );
  });

  it('shows nothing when there is no list', () => {
    expect(showTodoPanel([], LIVE)).toBe(false);
  });

  /*
   * Finishing a list and then adding to it is ordinary mid-turn behaviour, so
   * the column stays until the turn is over rather than blinking out between
   * the last tick and the next item.
   */
  it('keeps a finished list while the turn is still running', () => {
    expect(showTodoPanel([item('1', 'completed')], { ...LIVE, streaming: true })).toBe(true);
  });

  it('gives the column back once the work is done and the turn has ended', () => {
    expect(showTodoPanel([item('1', 'completed')], { ...LIVE, streaming: false })).toBe(false);
  });

  it('keeps it for a list still holding open work between turns', () => {
    expect(showTodoPanel(items, { ...LIVE, streaming: false })).toBe(true);
  });

  /*
   * Before the first measurement the pane could be any width. Guessing wide
   * would put a column into a narrow pane for one frame and then snatch it
   * back, taking the conversation sideways with it.
   */
  it('waits for a measurement rather than guessing', () => {
    expect(showTodoPanel(items, { ...LIVE, width: null })).toBe(false);
  });
});
