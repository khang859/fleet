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
    todos: null,
    // A row that dispatched nothing still has to say so. Left out, the pane
    // reads it as a call it has not been told about yet and goes looking for a
    // subagent that was never there.
    task: null
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

/**
 * A turn stopped on a permission question, at the foot of a transcript long
 * enough to scroll.
 *
 * The question arrives a beat after the transcript, rather than with it, because
 * the bug it exists to show is about what happens to a reader already parked at
 * the tail when the card appears under them - which a state seeded all at once
 * cannot reproduce.
 */
const AGENT_PERMISSION_ASK = `(() => {
  const store = __FLEET__.stores.agent;
  const paneId = Object.keys(store.getState().threads)[0];
  if (paneId === undefined) return 'no agent pane open - open one first';
  const thread = store.getState().threads[paneId];

  const streamId = 'fixture-stream';
  const callId = 'fixture-call';
  const message = (id, role, parts) => ({
    id,
    role,
    parts,
    reasoning: '',
    reasoningMs: 0,
    createdAt: Date.now()
  });
  const said = (n) => message('fixture-a' + n, 'assistant', [
    { type: 'text', text: 'Paragraph ' + n + '. ' + 'Filling the pane so the transcript scrolls. '.repeat(6) },
    { type: 'tool', call: { id: 'done' + n, name: 'read', args: '{}', result: 'ok', error: null, summary: '40 lines', image: null, todos: null, task: null } }
  ]);

  const write = (extra) => store.setState((s) => ({
    threads: { ...s.threads, [paneId]: { ...s.threads[paneId], ...extra } }
  }));

  write({
    messages: [
      message('fixture-u1', 'user', [{ type: 'text', text: 'Tidy up the branch.' }]),
      ...[1, 2, 3, 4, 5, 6, 7, 8].map(said),
      message('fixture-a9', 'assistant', [
        { type: 'text', text: 'Removing the merged branches now.' },
        { type: 'tool', call: { id: callId, name: 'bash', args: '{}', result: null, error: null, summary: null, image: null, todos: null, task: null } }
      ])
    ],
    streamId,
    startedAt: Date.now(),
    pendingPermission: null,
    // Cleared as well as set: a fixture run after another one should show its
    // own state and not half of the last one's.
    taskPermissions: {}
  });

  // Long enough for the transcript to settle at the tail and for the reader to
  // be looking at it, which is the state the question has to interrupt.
  setTimeout(() => {
    write({
      pendingPermission: {
        streamId,
        requestId: 'fixture-request',
        callId,
        command: 'git branch --merged main | grep -v main | xargs git branch -d',
        reason: 'Deletes branches, which cannot be undone from here.',
        rule: 'git branch:*',
        mcp: null
      }
    });
  }, 1500);

  return 'seeded pane ' + paneId + ': the permission card lands in 1.5s and should scroll itself into view';
})()`;

/**
 * Two subagents stopped on a command, asking from the pinned strip.
 *
 * The strip is the half of this that a real turn is slow and expensive to
 * reproduce: it takes a dispatch, a child that gets far enough to want a
 * command, and a second one behind it. The questions arrive a beat apart on
 * purpose - the second one lands while the first is already up, which is where
 * "held back" and "left where it is" have to be told apart.
 */
const AGENT_TASK_PERMISSION_ASK = `(() => {
  const store = __FLEET__.stores.agent;
  const paneId = Object.keys(store.getState().threads)[0];
  if (paneId === undefined) return 'no agent pane open - open one first';

  const task = (id, agent, prompt) => ({
    id,
    agent,
    prompt,
    status: 'running',
    summary: null
  });
  const dispatch = (callId, info) => ({
    type: 'tool',
    call: { id: callId, name: 'task', args: '{}', result: null, error: null, summary: null, image: null, todos: null, task: info }
  });
  const message = (id, role, parts) => ({
    id,
    role,
    parts,
    reasoning: '',
    reasoningMs: 0,
    createdAt: Date.now()
  });
  const asking = (requestId, command) => ({
    streamId: 'fixture-child-' + requestId,
    requestId,
    callId: 'fixture-child-call-' + requestId,
    command,
    reason: 'Changes the repository, so it is not one of the read-only commands.',
    rule: 'git:*',
    mcp: null
  });

  const write = (extra) => store.setState((s) => ({
    threads: { ...s.threads, [paneId]: { ...s.threads[paneId], ...extra } }
  }));

  write({
    messages: [
      message('fixture-u1', 'user', [{ type: 'text', text: 'Look at the test failures and the release notes.' }]),
      message('fixture-a1', 'assistant', [
        { type: 'text', text: 'Sending two off to look in parallel.' },
        dispatch('fixture-d1', task('fixture-task-1', 'explore', 'Find what broke the snapshot tests.')),
        dispatch('fixture-d2', task('fixture-task-2', 'review', 'Check the release notes against the log.'))
      ])
    ],
    streamId: 'fixture-stream',
    startedAt: Date.now(),
    pendingPermission: null,
    taskPermissions: {}
  });

  setTimeout(() => {
    write({ taskPermissions: { 'fixture-task-1': asking('fixture-req-1', 'git bisect start HEAD v2.90.0') } });
  }, 1500);
  setTimeout(() => {
    write({
      taskPermissions: {
        'fixture-task-1': asking('fixture-req-1', 'git bisect start HEAD v2.90.0'),
        'fixture-task-2': asking('fixture-req-2', 'git log --oneline v2.90.0..HEAD > /tmp/notes.txt')
      }
    });
  }, 4000);

  return 'seeded pane ' + paneId + ': subagent questions land at 1.5s and 4s. Type through either to see the strip held back.';
})()`;

/**
 * A downloaded update, waiting to be installed.
 *
 * Reaching this for real means publishing a release and running a packaged
 * build against it, which is not a loop anyone can iterate the nudge in. So the
 * fixture asks *main* to emit the status rather than writing the store itself:
 * it goes out through the same `sendUpdateStatus` a real `update-downloaded`
 * does, so the IPC, the preload bridge, the hook, the store, the toast and the
 * pill are all the real ones. Only `electron-updater` itself is stubbed out.
 *
 * The notes are shaped like the ones the release pipeline actually produces,
 * which is the part worth being careful about. `extract-release-notes.ts` takes
 * the body under a `## vX.Y.Z` heading and drops the heading itself, so what
 * arrives is a flat list of bullets with a bold lead and several hundred words
 * behind it - no headings, and far longer than a mock would tend to be. A
 * dialog that only ever gets tried against three short lines would look fine
 * here and be a wall of text in front of a real release.
 */
const UPDATE_READY = `(() => {
  if (!window.fleet.updates.simulateUpdate) return 'build is too old for this fixture';
  window.fleet.updates.simulateUpdate({
    state: 'ready',
    version: '2.113.0',
    releaseNotes: [
      "- **Long-running windows find out about updates** - Fleet checked for a new version once, just after launch, and never again. That answers the question for a session that lasts minutes and quietly stops answering it for one that lasts days, which is the normal case here: the window holds running agents and nobody closes it. At roughly one release every two or three days, a window left open for a week could be several versions behind while showing nothing at all. It now re-checks every four hours, when the window regains focus, and when the machine wakes, with all three behind a single throttle so that opening a laptop lid - which fires the wake and the focus together, often with the timer due as well - is one check rather than three.",
      "",
      "- **Installing asks before it stops running agents** - \\\`Restart to Update\\\` went straight to the updater, which on Windows and Linux spawns the installer *before* it asks the app to quit. The close warning added in the last release then appeared after the installer was already running, so answering 'cancel' left the app open and being replaced underneath it. The question is now asked first, through the same check a Cmd+Q goes through, and nothing is spawned until it has been answered.",
      "",
      "- **Release notes read as notes** - they were rendered as literal text, so every \\\`-\\\` and \\\`**\\\` in this file showed up as punctuation. See the [changelog](https://github.com/khang859/fleet/blob/main/CHANGELOG.md) for the full history."
    ].join('\\n')
  });
  return 'sent update-ready: pill in the title strip, toast for 10s, click the pill for the notes';
})()`;

/**
 * The same update, arriving while the window has no toast history.
 *
 * The re-toast gap is a day, so the second run of `update-ready` in a session
 * deliberately says nothing - correct, and indistinguishable from a broken
 * toast. This clears the record first so the nudge can be watched again.
 */
const UPDATE_RENUDGE = `(() => {
  localStorage.removeItem('fleet:update-last-toast');
  return 'cleared the toast record - run "fixture update-ready" again to see it announce';
})()`;

/**
 * A staged update overtaken by a newer one whose download then fails.
 *
 * The sequence is the one that used to leave a lie on screen. `electron-updater`
 * empties its pending directory the moment it starts fetching a build whose
 * checksum differs from the cached one, and empties it again when that download
 * throws - so by the end of this, 2.113.0's installer has been deleted twice
 * over and pressing the pill would fail with "No update filepath provided".
 * The pill has to go, and Settings has to offer a check again.
 */
const UPDATE_SUPERSEDED = `(() => {
  if (!window.fleet.updates.simulateUpdate) return 'build is too old for this fixture';
  const u = window.fleet.updates;
  u.simulateUpdate({ state: 'ready', version: '2.113.0', releaseNotes: '- staged' });
  setTimeout(() => {
    u.simulateUpdate({ state: 'downloading', version: '2.114.0', releaseNotes: '- newer', percent: 12 });
  }, 1500);
  setTimeout(() => {
    u.simulateUpdate({ state: 'error', message: 'net::ERR_CONNECTION_RESET' });
  }, 3000);
  return 'staged 2.113.0; 2.114.0 starts downloading at 1.5s and fails at 3s - the pill should disappear and Settings should offer Check for Updates again';
})()`;

export const FIXTURES: Record<string, Fixture> = {
  'agent-cleared-results': {
    describe:
      'An agent transcript old enough that its first two tool results have been dropped from what the model is sent. The two oldest rows should be marked "cleared"; the five recent ones should not.',
    source: AGENT_CLEARED_RESULTS
  },
  'agent-permission-ask': {
    describe:
      'A streaming turn that stops on a permission question 1.5s after the transcript is seeded. The card should scroll fully into view, and Enter in the composer should run the command. Type into the composer as it lands to see the question held back until the typing stops.',
    source: AGENT_PERMISSION_ASK
  },
  'agent-task-permission-ask': {
    describe:
      'Two subagents stopping on a command, 1.5s and 4s after the transcript is seeded. The pinned strip should appear only once the composer has been quiet for a second, and the first question should stay put when the second one is held back.',
    source: AGENT_TASK_PERMISSION_ASK
  },
  'update-ready': {
    describe:
      'A downloaded update announced by the main process over the real status channel. A version pill should appear in the title strip and stay, and a toast with a Restart action should run for 10s. Clicking the pill opens the notes rendered as Markdown. Running it twice in a day is silent by design - use "update-renudge" first.',
    source: UPDATE_READY
  },
  'update-renudge': {
    describe:
      'Forgets that the update nudge was already shown, so "update-ready" announces itself again instead of only leaving the pill.',
    source: UPDATE_RENUDGE
  },
  'update-superseded': {
    describe:
      'A staged update overtaken by a newer one whose download then fails, which deletes both installers. The pill should disappear rather than offer an install that would fail, and Settings should go back to offering Check for Updates.',
    source: UPDATE_SUPERSEDED
  }
};

/** The fixture names, for the listing and for the unknown-name error. */
export function fixtureNames(): string[] {
  return Object.keys(FIXTURES).sort();
}
