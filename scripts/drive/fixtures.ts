/**
 * Named renderer-state fixtures, for seeing a UI state that is otherwise
 * expensive or slow to reach.
 *
 * Some states are gated behind a real conversation: the "cleared" marker on a
 * tool row only appears once a session has accumulated tens of thousands of
 * tokens of stale tool output, which means a long agent run and real money
 * spent to look at one word on one row. A fixture puts the pane in that state
 * directly, so the rendering can be checked on its own.
 *
 * Each fixture is JS source rather than a typed builder, because it is
 * evaluated inside the renderer where none of this file's imports exist. They
 * find what they need from `__FLEET__.stores` rather than taking arguments, so
 * a fixture is one word to run and cannot be pointed at the wrong pane.
 *
 * Nothing here is persisted. State is written straight into the zustand store,
 * so reloading the window (Cmd+R) throws all of it away - which is the intended
 * way to clean up, and the reason a fixture is safe to run against a real
 * session that is sitting open.
 */

export type Fixture = {
  /** What the fixture puts on screen, and what to look at once it has. */
  describe: string;
  /** An IIFE evaluated in the renderer. Should return a short status string. */
  source: string;
};

/**
 * A transcript whose oldest tool results have aged out of what gets sent.
 *
 * Two old calls big enough to clear, then `CLEAR_KEEP_RECENT` fresh ones - the
 * boundary case, since one fewer recent call would keep the old ones and one
 * more would be a fixture that proves nothing.
 */
const AGENT_CLEARED_RESULTS = `(() => {
  const store = __FLEET__.stores.agent;
  const paneId = Object.keys(store.getState().threads)[0];
  if (paneId === undefined) return 'no agent pane open - open one first';
  const thread = store.getState().threads[paneId];

  const call = (id, name, chars, summary) => ({
    id,
    name,
    args: JSON.stringify({ path: 'src/example-' + id + '.ts' }),
    result: 'x'.repeat(chars),
    error: null,
    summary,
    image: null,
    todos: null
  });
  const message = (id, role, parts) => ({
    id,
    role,
    parts,
    reasoning: '',
    reasoningMs: 0,
    createdAt: Date.now()
  });

  const recent = ['new0', 'new1', 'new2', 'new3', 'new4'].map((id) => ({
    type: 'tool',
    call: call(id, 'read', 200, '12 lines')
  }));

  store.setState({
    threads: {
      ...store.getState().threads,
      [paneId]: {
        ...thread,
        messages: [
          message('fixture-u1', 'user', [{ type: 'text', text: 'Trace how compaction works.' }]),
          message('fixture-a1', 'assistant', [
            { type: 'text', text: 'Reading the relevant files.' },
            { type: 'tool', call: call('old1', 'read', 45000, '900 lines') },
            { type: 'tool', call: call('old2', 'grep', 45000, '120 matches') }
          ]),
          message('fixture-u2', 'user', [{ type: 'text', text: 'and the store?' }]),
          message('fixture-a2', 'assistant', [
            ...recent,
            { type: 'text', text: 'Both of the older results are stale now.' }
          ])
        ]
      }
    }
  });
  return 'seeded pane ' + paneId + ': the two oldest rows should read "cleared"';
})()`;

export const FIXTURES: Record<string, Fixture> = {
  'agent-cleared-results': {
    describe:
      'An agent transcript old enough that its first two tool results have been dropped from what the model is sent. The two oldest rows should be marked "cleared"; the five recent ones should not.',
    source: AGENT_CLEARED_RESULTS
  }
};

/** The fixture names, for the listing and for the unknown-name error. */
export function fixtureNames(): string[] {
  return Object.keys(FIXTURES).sort();
}
