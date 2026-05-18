# Agent Status Detection (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect which AI agent (claude / pi / codex) is running in each pane and report semantic state (working / blocked / done / idle) by reading the rendered terminal output, then surface that state to the renderer so badges become more accurate.

**Architecture:** Add a new `AgentDetector` in the main process. On every PTY data event, it appends ANSI-stripped output to a per-pane ring buffer, identifies the agent from `ptyManager.getProcessName()`, and runs an agent-specific heuristic over the buffer. Definitive signals (`blocked`, `working`) route into the existing `ActivityTracker` (`onNeedsMe` / `onData`) rather than creating a parallel state machine. The detected agent label flows through the existing `activity-state-change` event so the renderer can show which agent each pane is running.

**Tech Stack:** TypeScript, Electron main process, node-pty, Vitest. Pattern source: `reference/herdr/src/detect.rs` (AGPL — patterns are reimplemented in clean-room TS, not copied verbatim).

**Out of scope for Phase 1:** gemini, cursor, droid, amp, opencode, grok, kimi, copilot, cline detectors. Rich agent-aware sidebar grouping. Hook-installer commands (those are Phase 3). The existing `notification-detector.ts` generic permission regexes remain in place as a fallback for unknown agents.

---

## File Structure

| Path | Role |
|---|---|
| `src/shared/types.ts` | Add `AgentId` type. Extend nothing else. |
| `src/shared/ipc-api.ts` | Add optional `agent` field to `ActivityStatePayload`. |
| `src/main/agent-detector.ts` (new) | Per-pane buffer + agent identification + state heuristics. |
| `src/main/__tests__/agent-detector.test.ts` (new) | Unit tests for identification + each agent's heuristics. |
| `src/main/event-bus.ts` | Add optional `agent` field to `activity-state-change` event. |
| `src/main/activity-tracker.ts` | Forward `agent` field in emitted events; accept it via existing methods. |
| `src/main/index.ts` | Construct `AgentDetector`, pass it to handlers. |
| `src/main/ipc-handlers.ts` | Call `agentDetector.onData()` in the PTY data callback, route blocked → `tracker.onNeedsMe()`. |
| `src/preload/index.ts` | No type change needed (uses re-exported types). |
| `src/renderer/src/store/notification-store.ts` | Store `agent` in `ActivityRecord`. |
| `src/renderer/src/components/Sidebar.tsx` | Add agent name to tab tooltip (small UI surface). |

---

## Task 1: Add `AgentId` type and extend payload

**Files:**
- Modify: `src/shared/types.ts:53` (right after `ActivityState`)
- Modify: `src/shared/ipc-api.ts:80-85` (extend `ActivityStatePayload`)

- [ ] **Step 1: Add the `AgentId` type**

Edit `src/shared/types.ts` — find the line:

```ts
export type ActivityState = 'working' | 'idle' | 'done' | 'needs_me' | 'error';
```

Add immediately after it:

```ts
/**
 * Known coding agents Fleet can identify from the foreground process name.
 * Phase 1 covers claude, pi, codex. Future phases will add more.
 */
export type AgentId = 'claude' | 'pi' | 'codex';
```

- [ ] **Step 2: Extend `ActivityStatePayload`**

Edit `src/shared/ipc-api.ts`:

```ts
import type { Workspace, NotificationEvent, ActivityState, AgentId } from './types';
```

Replace the existing `ActivityStatePayload`:

```ts
export type ActivityStatePayload = {
  paneId: string;
  state: ActivityState;
  lastOutputAt: number;
  timestamp: number;
  /** Detected agent running in this pane, if any. */
  agent?: AgentId;
};
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/types.ts src/shared/ipc-api.ts
git commit -m "feat(types): add AgentId and extend ActivityStatePayload"
```

---

## Task 2: AgentDetector skeleton + agent identification

**Files:**
- Create: `src/main/agent-detector.ts`
- Create: `src/main/__tests__/agent-detector.test.ts`

- [ ] **Step 1: Write the failing identification tests**

Create `src/main/__tests__/agent-detector.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { identifyAgent, stripAnsi } from '../agent-detector';

describe('identifyAgent', () => {
  it.each([
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['Claude', 'claude'],
    ['pi', 'pi'],
    ['codex', 'codex']
  ])('identifies %s as %s', (processName, expected) => {
    expect(identifyAgent(processName)).toBe(expected);
  });

  it('returns null for shells', () => {
    expect(identifyAgent('zsh')).toBeNull();
    expect(identifyAgent('bash')).toBeNull();
  });

  it('returns null for empty / undefined-like inputs', () => {
    expect(identifyAgent('')).toBeNull();
    expect(identifyAgent('   ')).toBeNull();
  });
});

describe('stripAnsi', () => {
  it('removes CSI sequences', () => {
    expect(stripAnsi('\x1b[31mhi\x1b[0m')).toBe('hi');
  });

  it('removes OSC sequences', () => {
    expect(stripAnsi('before\x1b]0;title\x07after')).toBe('beforeafter');
  });

  it('leaves plain text alone', () => {
    expect(stripAnsi('hello world')).toBe('hello world');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the AgentDetector module skeleton**

Create `src/main/agent-detector.ts`:

```ts
import type { AgentId } from '../shared/types';

const PROCESS_NAME_TO_AGENT: Record<string, AgentId> = {
  claude: 'claude',
  'claude-code': 'claude',
  pi: 'pi',
  codex: 'codex'
};

/** Identify an agent by foreground process name. Returns null for shells / unknown. */
export function identifyAgent(processName: string): AgentId | null {
  const name = processName.trim().toLowerCase();
  if (!name) return null;
  return PROCESS_NAME_TO_AGENT[name] ?? null;
}

// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
// OSC sequences end with BEL (\x07) or ST (\x1b\\)
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// Other escape sequences (single-char or 2-char) — strip the ESC + 1 char fallback
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1b[@-Z\\-_]/g;

export function stripAnsi(input: string): string {
  return input.replace(ANSI_OSC, '').replace(ANSI_CSI, '').replace(ANSI_OTHER, '');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: PASS (all tests for `identifyAgent` and `stripAnsi`)

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-detector.ts src/main/__tests__/agent-detector.test.ts
git commit -m "feat(agent-detector): add agent identification and ANSI stripping"
```

---

## Task 3: Pi detector + buffer state

**Files:**
- Modify: `src/main/agent-detector.ts`
- Modify: `src/main/__tests__/agent-detector.test.ts`

- [ ] **Step 1: Write failing tests for the AgentDetector class and pi heuristic**

Append to `src/main/__tests__/agent-detector.test.ts`:

```ts
import { AgentDetector } from '../agent-detector';

describe('AgentDetector (pi)', () => {
  it('returns null detection when no process name is known yet', () => {
    const det = new AgentDetector({ getProcessName: () => undefined });
    det.trackPane('p1');
    det.onData('p1', 'some output\n');
    expect(det.getDetection('p1')).toEqual({ agent: null, state: null });
  });

  it('identifies pi from process name', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', 'arbitrary output\n');
    expect(det.getDetection('p1').agent).toBe('pi');
  });

  it('reports pi as working when "Working..." appears', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    expect(det.getDetection('p1')).toEqual({ agent: 'pi', state: 'working' });
  });

  it('reports pi as idle when no working marker is present', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', '> ready\n');
    expect(det.getDetection('p1')).toEqual({ agent: 'pi', state: 'idle' });
  });

  it('untrackPane clears state', () => {
    const det = new AgentDetector({ getProcessName: () => 'pi' });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    det.untrackPane('p1');
    expect(det.getDetection('p1')).toEqual({ agent: null, state: null });
  });

  it('emits a state-change signal to onSignal callback', () => {
    const signals: Array<{ paneId: string; agent: string | null; state: string | null }> = [];
    const det = new AgentDetector({
      getProcessName: () => 'pi',
      onSignal: (paneId, agent, state) => signals.push({ paneId, agent, state })
    });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    expect(signals).toContainEqual({ paneId: 'p1', agent: 'pi', state: 'working' });
  });

  it('does not emit duplicate signals when state is unchanged', () => {
    const signals: Array<{ paneId: string; agent: string | null; state: string | null }> = [];
    const det = new AgentDetector({
      getProcessName: () => 'pi',
      onSignal: (paneId, agent, state) => signals.push({ paneId, agent, state })
    });
    det.trackPane('p1');
    det.onData('p1', 'Working...\n');
    det.onData('p1', 'Working...\n');
    expect(signals.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: FAIL — `AgentDetector` not exported.

- [ ] **Step 3: Implement the AgentDetector class with pi heuristic**

Append to `src/main/agent-detector.ts`:

```ts
/** Maximum ANSI-stripped bytes kept per pane buffer. */
const BUFFER_LIMIT_BYTES = 8 * 1024;

export type AgentDetectionState = 'working' | 'blocked' | 'idle';

export type AgentDetection = {
  agent: AgentId | null;
  state: AgentDetectionState | null;
};

export type AgentDetectorOptions = {
  /** Resolve the current foreground process name for a pane. */
  getProcessName: (paneId: string) => string | undefined;
  /** Called whenever a pane's (agent, state) tuple changes. */
  onSignal?: (paneId: string, agent: AgentId | null, state: AgentDetectionState | null) => void;
};

type PaneEntry = {
  buffer: string;
  lastAgent: AgentId | null;
  lastState: AgentDetectionState | null;
};

export class AgentDetector {
  private panes = new Map<string, PaneEntry>();
  private opts: AgentDetectorOptions;

  constructor(opts: AgentDetectorOptions) {
    this.opts = opts;
  }

  trackPane(paneId: string): void {
    if (this.panes.has(paneId)) return;
    this.panes.set(paneId, { buffer: '', lastAgent: null, lastState: null });
  }

  untrackPane(paneId: string): void {
    this.panes.delete(paneId);
  }

  onData(paneId: string, data: string): void {
    const entry = this.panes.get(paneId);
    if (!entry) return;

    entry.buffer = (entry.buffer + stripAnsi(data)).slice(-BUFFER_LIMIT_BYTES);

    const processName = this.opts.getProcessName(paneId);
    const agent = processName ? identifyAgent(processName) : null;
    const state = agent ? detectState(agent, entry.buffer) : null;

    if (agent !== entry.lastAgent || state !== entry.lastState) {
      entry.lastAgent = agent;
      entry.lastState = state;
      this.opts.onSignal?.(paneId, agent, state);
    }
  }

  getDetection(paneId: string): AgentDetection {
    const entry = this.panes.get(paneId);
    if (!entry) return { agent: null, state: null };
    return { agent: entry.lastAgent, state: entry.lastState };
  }
}

function detectState(agent: AgentId, content: string): AgentDetectionState {
  switch (agent) {
    case 'pi':
      return detectPi(content);
    case 'claude':
    case 'codex':
      // Implemented in later tasks.
      return 'idle';
  }
}

function detectPi(content: string): AgentDetectionState {
  if (content.includes('Working...')) return 'working';
  return 'idle';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: PASS (all tests including AgentDetector pi cases)

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-detector.ts src/main/__tests__/agent-detector.test.ts
git commit -m "feat(agent-detector): add AgentDetector class with pi heuristic"
```

---

## Task 4: Claude detector

**Files:**
- Modify: `src/main/agent-detector.ts`
- Modify: `src/main/__tests__/agent-detector.test.ts`

- [ ] **Step 1: Write failing tests for claude detection**

Append to `src/main/__tests__/agent-detector.test.ts`:

```ts
describe('AgentDetector (claude)', () => {
  const newDet = () =>
    new AgentDetector({ getProcessName: () => 'claude' });

  it('reports working when "esc to interrupt" appears', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '   running tool...\n   esc to interrupt\n');
    expect(det.getDetection('p1').state).toBe('working');
  });

  it('reports working when "ctrl+c to interrupt" appears', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '   thinking...\n   ctrl+c to interrupt\n');
    expect(det.getDetection('p1').state).toBe('working');
  });

  it('reports blocked when "Do you want to proceed?" appears', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'Run command? Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports blocked on "waiting for permission"', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'waiting for permission\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports idle on a quiescent prompt', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '─────────\n❯ \n─────────\n');
    expect(det.getDetection('p1').state).toBe('idle');
  });

  it('blocked takes precedence over working signals on same screen', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'esc to interrupt\n\nDo you want to proceed?\n  ❯ 1. Yes\n    2. No\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: FAIL — claude tests fail (currently returns 'idle').

- [ ] **Step 3: Implement detectClaude**

Edit `src/main/agent-detector.ts` — replace the `detectState` `case 'claude':` line and add `detectClaude` below `detectPi`:

```ts
    case 'claude':
      return detectClaude(content);
```

Then add at the bottom of the file:

```ts
const CLAUDE_BLOCKED_PHRASES = [
  'do you want to proceed?',
  'would you like to proceed?',
  'waiting for permission',
  'do you want to allow this connection?'
];

const CLAUDE_WORKING_PHRASES = ['esc to interrupt', 'ctrl+c to interrupt'];

function detectClaude(content: string): AgentDetectionState {
  const lower = content.toLowerCase();

  // Blocked first — confirmation prompts always win over working markers on the same screen.
  for (const phrase of CLAUDE_BLOCKED_PHRASES) {
    if (lower.includes(phrase)) return 'blocked';
  }
  if (hasClaudeYesNoChoice(content)) return 'blocked';

  for (const phrase of CLAUDE_WORKING_PHRASES) {
    if (lower.includes(phrase)) return 'working';
  }

  return 'idle';
}

function hasClaudeYesNoChoice(content: string): boolean {
  // Claude renders "❯ 1. Yes" / "  2. No" for permission selects.
  let sawYes = false;
  let sawNo = false;
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim().replace(/^❯\s*/, '').toLowerCase();
    if (line.startsWith('1. yes') || line === 'yes') sawYes = true;
    if (line.startsWith('2. no') || line === 'no') sawNo = true;
    if (sawYes && sawNo) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-detector.ts src/main/__tests__/agent-detector.test.ts
git commit -m "feat(agent-detector): add claude state heuristics"
```

---

## Task 5: Codex detector

**Files:**
- Modify: `src/main/agent-detector.ts`
- Modify: `src/main/__tests__/agent-detector.test.ts`

- [ ] **Step 1: Write failing tests for codex detection**

Append to `src/main/__tests__/agent-detector.test.ts`:

```ts
describe('AgentDetector (codex)', () => {
  const newDet = () =>
    new AgentDetector({ getProcessName: () => 'codex' });

  it('reports blocked on "press enter to confirm or esc to cancel"', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'Press Enter to confirm or Esc to cancel\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports blocked on "Allow command?"', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'Allow command? [y/n]\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports blocked on "[y/n]" prompt', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'continue [y/n]\n');
    expect(det.getDetection('p1').state).toBe('blocked');
  });

  it('reports working when an interrupt hint is present', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'thinking...\nesc to interrupt\n');
    expect(det.getDetection('p1').state).toBe('working');
  });

  it('reports working on a codex working header line', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', '• Working (32s · esc to interrupt)\n');
    expect(det.getDetection('p1').state).toBe('working');
  });

  it('reports idle when neither blocked nor working markers appear', () => {
    const det = newDet();
    det.trackPane('p1');
    det.onData('p1', 'user > ');
    expect(det.getDetection('p1').state).toBe('idle');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: FAIL — codex tests fail (currently returns 'idle').

- [ ] **Step 3: Implement detectCodex**

Edit `src/main/agent-detector.ts` — replace the `case 'codex':` branch and add `detectCodex`:

```ts
    case 'codex':
      return detectCodex(content);
```

Append:

```ts
const CODEX_BLOCKED_PHRASES = [
  'press enter to confirm or esc to cancel',
  'enter to submit answer',
  'allow command?',
  '[y/n]',
  'yes (y)'
];

const CODEX_INTERRUPT_PHRASES = ['esc to interrupt', 'ctrl+c to interrupt'];

function detectCodex(content: string): AgentDetectionState {
  const lower = content.toLowerCase();

  for (const phrase of CODEX_BLOCKED_PHRASES) {
    if (lower.includes(phrase)) return 'blocked';
  }

  for (const phrase of CODEX_INTERRUPT_PHRASES) {
    if (lower.includes(phrase)) return 'working';
  }

  if (hasCodexWorkingHeader(content)) return 'working';

  return 'idle';
}

function hasCodexWorkingHeader(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('•') && trimmed.includes('Working (')) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/agent-detector.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-detector.ts src/main/__tests__/agent-detector.test.ts
git commit -m "feat(agent-detector): add codex state heuristics"
```

---

## Task 6: Forward `agent` through the event bus and ActivityTracker

**Files:**
- Modify: `src/main/event-bus.ts`
- Modify: `src/main/activity-tracker.ts`
- Modify: `src/main/__tests__/activity-tracker.test.ts`

- [ ] **Step 1: Extend the event-bus event type**

Edit `src/main/event-bus.ts`. Find the `activity-state-change` event and extend it:

```ts
import type { NotificationLevel, ActivityState, AgentId } from '../shared/types';
```

In the event-bus event map (around line 10), update `activity-state-change`:

```ts
'activity-state-change': {
  type: 'activity-state-change';
  paneId: string;
  state: ActivityState;
  lastOutputAt: number;
  timestamp: number;
  agent?: AgentId;
};
```

(Adapt to the exact existing shape — only the `agent?: AgentId` field is new.)

- [ ] **Step 2: Plumb `agent` through ActivityTracker — write the failing test first**

Append to `src/main/__tests__/activity-tracker.test.ts`:

```ts
import type { AgentId } from '../../shared/types';

describe('ActivityTracker agent forwarding', () => {
  it('includes agent in emitted events when setAgent has been called', () => {
    const eventBus = new (require('../event-bus').EventBus)();
    const getProcessName = vi.fn().mockReturnValue('zsh');
    const tracker = new ActivityTracker(eventBus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 10_000,
      getProcessName
    });
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('p1');
    tracker.setAgent('p1', 'claude' satisfies AgentId);
    tracker.onData('p1');

    expect(callback).toHaveBeenCalledWith(
      expect.objectContaining({ paneId: 'p1', state: 'working', agent: 'claude' })
    );

    tracker.dispose();
  });

  it('omits agent when none set', () => {
    const eventBus = new (require('../event-bus').EventBus)();
    const getProcessName = vi.fn().mockReturnValue('zsh');
    const tracker = new ActivityTracker(eventBus, {
      silenceThresholdMs: 5000,
      processPollingIntervalMs: 10_000,
      getProcessName
    });
    const callback = vi.fn();
    eventBus.on('activity-state-change', callback);

    tracker.trackPane('p1');
    tracker.onData('p1');

    const arg = callback.mock.calls[0][0];
    expect(arg.agent).toBeUndefined();

    tracker.dispose();
  });
});
```

- [ ] **Step 3: Run the failing test**

Run: `npx vitest run src/main/__tests__/activity-tracker.test.ts`
Expected: FAIL — `setAgent` not implemented.

- [ ] **Step 4: Implement `setAgent` and forward through events**

Edit `src/main/activity-tracker.ts`:

```ts
import type { ActivityState, AgentId } from '../shared/types';
```

Extend `PaneState`:

```ts
type PaneState = {
  state: ActivityState;
  silenceTimer: ReturnType<typeof setTimeout> | null;
  lastOutputAt: number;
  exited: boolean;
  agent: AgentId | null;
};
```

In `trackPane`, initialize `agent: null`:

```ts
this.panes.set(paneId, {
  state: 'idle',
  silenceTimer: null,
  lastOutputAt: 0,
  exited: false,
  agent: null
});
```

Add a method just below `trackPane`:

```ts
setAgent(paneId: string, agent: AgentId | null): void {
  const pane = this.panes.get(paneId);
  if (!pane) return;
  if (pane.agent === agent) return;
  pane.agent = agent;
  // Re-emit current state so renderer learns about the agent.
  this.emitChange(paneId, pane.state, 'agent-changed');
}
```

Refactor `setState` to share an `emitChange` helper:

```ts
private setState(paneId: string, newState: ActivityState): void {
  const pane = this.panes.get(paneId);
  if (!pane) return;
  if (pane.state === newState) return;
  if (pane.state === 'needs_me' && newState === 'idle') return;

  pane.state = newState;
  this.emitChange(paneId, newState, 'state-changed');
}

private emitChange(paneId: string, state: ActivityState, _reason: string): void {
  const pane = this.panes.get(paneId);
  if (!pane) return;
  this.eventBus.emit('activity-state-change', {
    type: 'activity-state-change',
    paneId,
    state,
    lastOutputAt: pane.lastOutputAt,
    timestamp: Date.now(),
    ...(pane.agent ? { agent: pane.agent } : {})
  });
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/__tests__/activity-tracker.test.ts`
Expected: PASS (all existing tests still pass plus the two new ones)

- [ ] **Step 6: Commit**

```bash
git add src/main/event-bus.ts src/main/activity-tracker.ts src/main/__tests__/activity-tracker.test.ts
git commit -m "feat(activity-tracker): forward detected agent in state-change events"
```

---

## Task 7: Wire AgentDetector into the main process

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc-handlers.ts`

- [ ] **Step 1: Construct AgentDetector in `main/index.ts`**

Edit `src/main/index.ts`. After the `ActivityTracker` is constructed (around line 53–60), add:

```ts
import { AgentDetector } from './agent-detector';
// ...

const agentDetector = new AgentDetector({
  getProcessName: (paneId) => ptyManager.getProcessName(paneId),
  onSignal: (paneId, agent, state) => {
    activityTracker.setAgent(paneId, agent);
    if (state === 'blocked') {
      activityTracker.onNeedsMe(paneId);
    }
    // 'working' and 'idle' are handled by the existing onData / silence flow.
  }
});
```

In the `pane-closed` handler (around line 445), also untrack:

```ts
eventBus.on('pane-closed', (event) => {
  cwdPoller.stopPolling(event.paneId);
  activityTracker.untrackPane(event.paneId);
  agentDetector.untrackPane(event.paneId);
  setTimeout(() => pruneDeadCopilotSessions(), 500);
});
```

Pass `agentDetector` into `registerIpcHandlers` — add it to the call site:

```ts
registerIpcHandlers(
  ptyManager,
  layoutStore,
  eventBus,
  notificationDetector,
  notificationState,
  settingsStore,
  cwdPoller,
  gitService,
  () => mainWindow,
  workspacePath,
  activityTracker,
  new WorktreeService(),
  annotationStore,
  annotateService,
  piAgentManager,
  fleetBridge,
  piConfigManager,
  piAuthInspector,
  piEnvInjectionManager,
  agentDetector
);
```

- [ ] **Step 2: Accept AgentDetector in ipc-handlers and use it**

Edit `src/main/ipc-handlers.ts`. Add the import and parameter (match the existing signature style):

```ts
import type { AgentDetector } from './agent-detector';
```

Append `agentDetector: AgentDetector` to the `registerIpcHandlers` parameter list.

In the PTY create handler around line 117–129, add `agentDetector.trackPane` and call `onData`:

```ts
if (!alreadyExisted) {
  activityTracker.trackPane(req.paneId);
  agentDetector.trackPane(req.paneId);
  ptyManager.onData(req.paneId, (data, paused) => {
    notificationDetector.scan(req.paneId, data);
    activityTracker.onData(req.paneId);
    agentDetector.onData(req.paneId, data);
    const w = getWindow();
    if (w && !w.isDestroyed()) {
      w.webContents.send(IPC_CHANNELS.PTY_DATA, {
        paneId: req.paneId,
        data,
        paused
      } satisfies PtyDataPayload);
    }
  });
  // ... existing onExit block unchanged
}
```

- [ ] **Step 3: Typecheck + run full main-process tests**

Run: `npm run typecheck`
Expected: PASS

Run: `npx vitest run src/main/__tests__/`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/index.ts src/main/ipc-handlers.ts
git commit -m "feat(main): wire AgentDetector into PTY data flow"
```

---

## Task 8: Surface agent in the renderer store

**Files:**
- Modify: `src/renderer/src/store/notification-store.ts`
- Modify: `src/main/index.ts` (forward the field in the IPC send)

- [ ] **Step 1: Forward `agent` in the renderer-bound IPC message**

Edit `src/main/index.ts`. Find the `activity-state-change` listener around line 494:

```ts
eventBus.on('activity-state-change', (event) => {
  const w = mainWindow;
  if (w && !w.isDestroyed()) {
    w.webContents.send(IPC_CHANNELS.ACTIVITY_STATE, {
      paneId: event.paneId,
      state: event.state,
      lastOutputAt: event.lastOutputAt,
      timestamp: event.timestamp,
      ...(event.agent ? { agent: event.agent } : {})
    } satisfies ActivityStatePayload);
  }
});
```

(Match the existing block — only the spread of `agent` is new.)

- [ ] **Step 2: Store `agent` in the renderer ActivityRecord**

Edit `src/renderer/src/store/notification-store.ts`:

```ts
import type { NotificationLevel, ActivityState, AgentId } from '../../../shared/types';
```

Update `ActivityRecord`:

```ts
type ActivityRecord = {
  paneId: string;
  state: ActivityState;
  lastOutputAt: number;
  timestamp: number;
  agent?: AgentId;
};
```

The existing `setActivity` already accepts the full record, so no further change to the setter is needed.

- [ ] **Step 3: Wire the preload subscriber to pass `agent` through**

Find the existing `onStateChange` handler in the renderer (search: `onStateChange`). It already constructs an `ActivityRecord` from the payload — make sure it includes `agent`. For example:

```ts
window.api.activity.onStateChange((payload) => {
  setActivity({
    paneId: payload.paneId,
    state: payload.state,
    lastOutputAt: payload.lastOutputAt,
    timestamp: payload.timestamp,
    agent: payload.agent
  });
});
```

(If the existing code spreads the whole payload, no change needed.)

- [ ] **Step 4: Typecheck + verify renderer build**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/renderer/src/store/notification-store.ts src/renderer/src/
git commit -m "feat(renderer): expose detected agent in notification store"
```

---

## Task 9: Show the agent name in the sidebar tab tooltip

**Files:**
- Modify: `src/renderer/src/components/Sidebar.tsx`

- [ ] **Step 1: Locate the tab row rendering near `getTabBadge`**

Open `src/renderer/src/components/Sidebar.tsx` and find line 1198 where `badge={getTabBadge(paneIds)}` is rendered. Above that block, the tab row should already have a `title` (tooltip) attribute or a `Tooltip` wrapper.

- [ ] **Step 2: Pull `getTabActivity` and append agent name to the tooltip**

Edit the same component where `getTabBadge` is destructured (line 434):

```ts
const { getTabBadge, getTabActivity } = useNotificationStore();
```

Find where the tab is rendered (around line 1198). Compute the activity record and adjust the existing `title` or tooltip text:

```ts
const tabActivity = getTabActivity(paneIds);
const agentLabel = tabActivity?.agent
  ? ` (${tabActivity.agent})`
  : '';
const tabTitle = `${tab.label}${agentLabel}`;
```

Replace the existing `title=` (or equivalent) on the tab row with `title={tabTitle}`.

If the surrounding code uses a custom tooltip component, pass the new string into that component's prop instead. Adapt the exact location to current shape — the principle is: append ` (<agent>)` to the tooltip when an agent is detected.

- [ ] **Step 3: Update `getTabActivity` in the store to roll up agent**

Open `src/renderer/src/store/notification-store.ts`. Inspect `getTabActivity` — it already returns an `ActivityRecord` for the highest-priority pane in the tab. Confirm that record now includes the `agent` field (because `ActivityRecord` has it). No code change required if the implementation just returns the per-pane record.

- [ ] **Step 4: Manual smoke test the renderer**

Run: `npm run dev`
Expected: Fleet launches.

In a new pane:
1. Run `pi` — sidebar tooltip should show "(pi)" once any output appears.
2. Run `claude` — sidebar tooltip should show "(claude)".
3. Trigger a permission prompt in claude — the badge should become the permission color (already wired via `onNeedsMe`).

Document what you saw — if the UI does not update, check that the IPC payload carries `agent` (devtools console: `electron.api.activity.onStateChange`).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/components/Sidebar.tsx
git commit -m "feat(sidebar): surface detected agent name in tab tooltip"
```

---

## Task 10: Final verification + PR

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 3: Full unit test suite**

Run: `npx vitest run`
Expected: PASS — including the new `agent-detector.test.ts` and updated `activity-tracker.test.ts`

- [ ] **Step 4: Manual smoke test**

Run: `npm run dev`

For each agent (pi, claude, codex):
1. Open a new tab, run the agent.
2. Confirm in devtools that `onStateChange` payloads include `agent: '<name>'`.
3. Trigger a permission prompt in claude/codex.
4. Confirm the tab badge transitions to the permission color quickly (heuristic catch) and the tooltip shows the agent name.

- [ ] **Step 5: Open PR**

Use the `git-workflow` skill. Branch name: `feat/agent-status-detection`. PR title: `feat: per-agent state detection (claude / pi / codex)`. Reference this plan in the PR body.

---

## Self-Review Notes

- **Spec coverage**: every Phase 1 deliverable from the review (claude/pi/codex detectors, ActivityTracker integration, agent name in renderer) has a corresponding task above.
- **No placeholders**: every step contains actual code or commands.
- **Type consistency**: `AgentId`, `AgentDetectionState`, `ActivityState`, `setAgent`, `trackPane`, `onSignal`, `getDetection`, `getTabActivity` — all used consistently across tasks.
- **License note**: detection patterns are paraphrased from `reference/herdr/src/detect.rs` (AGPL-3.0). Implementations are reimplemented in TypeScript with a different structure — no verbatim source copied. Mention "patterns inspired by herdr" in commit/PR if anyone reviews the lineage.
