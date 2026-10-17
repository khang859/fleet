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

/**
 * The shipped release-note history, as Settings > Updates has it on a normal
 * launch - nothing simulated.
 *
 * Worth a fixture because the failure mode is silence: the list is fed by a
 * file read in main whose path differs between a dev run and a packaged build,
 * and a wrong path there produces an empty section rather than an error. This
 * reports what the page is actually holding so an empty list can be told apart
 * from a changelog that legitimately parsed to nothing.
 */
const RELEASE_HISTORY = `(async () => {
  if (!window.fleet.updates.getReleaseHistory) return 'build is too old for this fixture';
  const history = await window.fleet.updates.getReleaseHistory();
  const version = await window.fleet.updates.getVersion();
  if (history.length === 0) return 'EMPTY history - main could not read CHANGELOG.md; check the resolved path in release-notes-history.ts';
  const current = history.some((e) => e.version === version);
  return \`\${history.length} versions, \${history[0].version} down to \${history[history.length - 1].version}\` +
    (current ? \`; v\${version} is in the list and its row should be open and badged Current\`
             : \`; v\${version} is NOT in this build's changelog, so every row should be collapsed and none badged\`);
})()`;

/**
 * An Admiral with work under way: two jobs, questions open on the lobby and on
 * a job, and transcripts with the lines only an Admiral has.
 *
 * A job only exists once a model has opened one, and a question once the
 * Admiral has asked one, so a real run is the slow way to look at either. This
 * writes the agency mirror and the threads directly. Nothing is sent to main:
 * answering a card here is refused, which shows the refusal note. The next
 * agency change from main, or a reload, puts the real state back.
 */
const ADMIRAL_WORK = `(() => {
  const stores = __FLEET__.stores;
  const panes = stores.admiralRuntime.getState().panes;
  const paneId = Object.keys(panes).find((id) => panes[id].kind === 'ready');
  if (paneId === undefined) return 'no Admiral attached - turn Agency on and open one first';
  const repoId = Object.entries(stores.agency.getState().snapshots)[0]?.[0];
  if (repoId === undefined) return 'the Admiral has no agency state yet';
  const snap = stores.agency.getState().snapshots[repoId];

  const now = Date.now();
  const question = (id, jobId, extra) => ({
    id, repoId, jobId, planVersion: null, step: null, kind: 'ask',
    question: '', context: '', options: [], recommended: null, dependsOn: null,
    status: 'open', answerOption: null, answerText: null, late: false,
    withdrawnReason: null, createdAt: now, answeredAt: null, ...extra
  });
  const job = (id, extra) => ({
    id, repoId, title: '', brief: '', state: 'briefing', sessionId: 'fixture-job-' + id,
    handoffDone: true, budgetUsd: null, createdAt: now, updatedAt: now, ...extra
  });
  stores.agency.setState({
    snapshots: {
      ...stores.agency.getState().snapshots,
      [repoId]: {
        ...snap,
        jobs: [
          job(1, {
            title: 'Fix tab drag onto itself',
            brief: 'Dragging a tab onto its own drop zone removes it from the tab bar. It should snap back where it was, with no layout change.',
            budgetUsd: 25
          }),
          job(2, { title: 'Speed up cold start', state: 'running', budgetUsd: 40 })
        ],
        questions: [
          question(1, null, {
            question: 'Which branch should new jobs start from?',
            context: 'main is two commits behind origin/main.',
            options: [{ label: 'origin/main', detail: 'fetch first' }, { label: 'main' }],
            recommended: 0
          }),
          question(2, 1, {
            question: 'Keep the drop animation?',
            context: 'The fix is simpler if a self-drop skips the 150ms settle animation.',
            options: [
              { label: 'Skip it', detail: 'snap back at once' },
              { label: 'Keep it' },
              { label: 'Only on slow drags' }
            ],
            recommended: 0
          }),
          question(3, 1, {
            question: 'Add an e2e test for split panes too?',
            options: [{ label: 'Yes' }, { label: 'No' }],
            recommended: 1,
            status: 'withdrawn',
            withdrawnReason: 'the existing split test already covers it'
          }),
          question(4, 2, {
            kind: 'model_unreachable',
            question: 'The Admiral cannot reach its model',
            context: 'OpenRouter answered 401 Unauthorized four times. Check the key in an Agent pane\\'s Settings tab.',
            options: [{ label: 'Retry' }],
            recommended: 0
          })
        ]
      }
    }
  });

  const msg = (id, role, parts, meta) => ({
    id, role, parts, reasoning: '', reasoningMs: 0, citations: [], createdAt: now,
    ...(meta ? { meta } : {})
  });
  const text = (t) => [{ type: 'text', text: t }];
  const agent = stores.agent;
  const base = agent.getState().threads['admiral:' + paneId + ':lobby'];
  const put = (key, messages) => {
    agent.setState({
      threads: { ...agent.getState().threads, [key]: { ...base, sessionId: 'fixture-' + key, messages } }
    });
  };
  put('admiral:' + paneId + ':lobby', [
    msg('l1', 'user', text('Dragging a tab onto itself makes it vanish. Can you get that fixed?')),
    msg('l2', 'assistant', text('Yes. That is a contained fix, so I am opening a job for it and will plan it there.')),
    msg('l3', 'fleet', text('j1: Fix tab drag onto itself - opened'), { kind: 'job-link', jobId: 1 })
  ]);
  put('admiral:' + paneId + ':j1', [
    msg('j1', 'user', text('Dragging a tab onto itself makes it vanish. Can you get that fixed?')),
    msg('j2', 'assistant', [
      { type: 'text', text: 'I traced it to the drop handler, which removes the tab before checking where it lands. One thing to settle before I plan it:' },
      { type: 'tool', call: {
        id: 'c1', name: 'ask_client', args: JSON.stringify({ question: 'Keep the drop animation?' }),
        result: 'q2 is up for the client.', error: null, summary: 'asked q2', image: null, todos: null, task: null
      } }
    ]),
    msg('j3', 'fleet', text('Withdrew q3 · the existing split test already covers it\\n\\n<session-data session="q3">\\nAdd an e2e test for split panes too?\\n</session-data>'), { kind: 'event' })
  ]);
  stores.workspace.getState().setAdmiralActiveJob(paneId, 1);
  return 'seeded j1 (open question, withdrawn question) and j2 (model unreachable), lobby q1; showing j1';
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
  'release-history': {
    describe:
      'The release-note history Settings > Updates ships with. Open Settings > Updates: there should be one collapsible row per version, newest first, with only the running version open and badged "Current", its notes rendered as Markdown rather than literal punctuation, and the list scrolling inside its own box. Run "update-ready" alongside it to see a pending version pinned above the history, expanded and badged "Pending", and listed once rather than twice.',
    source: RELEASE_HISTORY
  },
  'update-superseded': {
    describe:
      'A staged update overtaken by a newer one whose download then fails, which deletes both installers. The pill should disappear rather than offer an install that would fail, and Settings should go back to offering Check for Updates.',
    source: UPDATE_SUPERSEDED
  },
  'admiral-work': {
    describe:
      'An Admiral with two job tabs, a question open on the lobby and on j1, a withdrawn question, and a model-unreachable card on j2. Shows j1: an ask_client card in the transcript, a withdrawal event line, and the sheet with WAITING ON YOU · 1. Needs Agency on and an Admiral open. Answers are refused, since main has no such questions.',
    source: ADMIRAL_WORK
  }
};

/** The fixture names, for the listing and for the unknown-name error. */
export function fixtureNames(): string[] {
  return Object.keys(FIXTURES).sort();
}
