import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { Bot, History, SlidersHorizontal } from 'lucide-react';
import { AgentThread } from './AgentThread';
import { AgentSessionsTab } from './AgentSessionsTab';
import { AgentTodoPanel } from './AgentTodoPanel';
import { AgentSubagentPanel } from './AgentSubagentPanel';
import { AgentSchedulePanel } from './AgentSchedulePanel';
import { showTodoPanel } from './todo-view';
import { runningSubagents, showSubagentPanel } from './subagent-view';
import { scheduleRows, showSchedulePanel } from './schedule-view';
import { cancelSchedule } from '../../store/agent-schedule';
import { SIDE_COLUMN_WIDTH_PX, centeringGutterPx } from './side-column';
import { AgentSettingsPanel } from './settings/AgentSettingsPanel';

import { useAgentStore } from '../../store/agent-store';
import { useElementWidth } from '../../hooks/use-element-width';
import { resolveBackgroundSrc } from '../../lib/pane-background';
import { getGlassCssVars, paneGround, paneBackdrop, PANE_GLASS } from '../../lib/theme';
import type { AgentTodoItem } from '../../../../shared/agent-todos';
import type { AgentScheduleRecord } from '../../../../shared/agent-schedule';
import type { AgentMessage, AgentPermissionAsk } from '../../../../shared/agent-types';
import type { TerminalBackground } from '../../../../shared/types';
import type { SlideshowFrame } from '../../hooks/use-slideshow';

type AgentView = 'agent' | 'sessions' | 'settings';

/** Stable empty list, so a pane with no thread does not resubscribe every render. */
const EMPTY_TODOS: AgentTodoItem[] = [];

/** The same, for a pane with no thread yet. */
const EMPTY_MESSAGES: AgentMessage[] = [];

/** The same, for a pane with no subagents running. */
const EMPTY_TASK_ACTIVITY: Record<string, string | null> = {};

/** The same, for a pane with no subagent waiting on a command. */
const EMPTY_TASK_PERMISSIONS: Record<string, AgentPermissionAsk> = {};

/** The same, for a conversation that has set nothing to wake itself up with. */
const EMPTY_SCHEDULES: AgentScheduleRecord[] = [];

/** The pane a `fleet:refocus-pane` event is about. */
const RefocusDetail = z.object({ paneId: z.string() });

const TABS = [
  { value: 'agent', label: 'Agent', Icon: Bot },
  { value: 'sessions', label: 'Sessions', Icon: History },
  { value: 'settings', label: 'Settings', Icon: SlidersHorizontal }
] as const satisfies ReadonlyArray<{ value: AgentView; label: string; Icon: typeof Bot }>;

/**
 * Native agent pane: a thread rooted in one folder, plus the settings every
 * agent pane shares - they run on the same provider and models and differ only
 * in the folder they work in.
 */
export function AgentPane({
  paneId,
  cwd,
  sessionId,
  terminalBackground,
  slideshowFrame
}: {
  paneId: string;
  cwd: string;
  /** Absent on panes created before sessions existed; those stay in memory. */
  sessionId?: string;
  /** The same picture the terminals are showing - one setting, one look. */
  terminalBackground?: TerminalBackground;
  slideshowFrame?: SlideshowFrame;
}): React.JSX.Element {
  const [view, setView] = useState<AgentView>('agent');
  const loadModels = useAgentStore((s) => s.loadModels);
  const loadKey = useAgentStore((s) => s.loadKey);
  const openSession = useAgentStore((s) => s.openSession);
  const todos = useAgentStore((s) => s.threads[paneId]?.todos ?? EMPTY_TODOS);
  const streaming = useAgentStore((s) => (s.threads[paneId]?.streamId ?? null) !== null);
  const messages = useAgentStore((s) => s.threads[paneId]?.messages ?? EMPTY_MESSAGES);
  const taskActivity = useAgentStore((s) => s.threads[paneId]?.taskActivity ?? EMPTY_TASK_ACTIVITY);
  const taskPermissions = useAgentStore(
    (s) => s.threads[paneId]?.taskPermissions ?? EMPTY_TASK_PERMISSIONS
  );
  // Worked out here rather than in each of the two places that show it, because
  // the transcript walk behind it would otherwise happen twice on every frame of
  // a streaming turn. It costs nothing at all when nothing is running, which is
  // most of every conversation.
  const running = useMemo(
    () => runningSubagents(messages, taskActivity, taskPermissions),
    [messages, taskActivity, taskPermissions]
  );
  const records = useAgentStore((s) => s.threads[paneId]?.schedules ?? EMPTY_SCHEDULES);
  // `now` is read once per change of the list rather than on every render: the
  // labels are "today 9:00 AM" and "Sep 3", which do not move minute to minute,
  // and a fresh `new Date()` each render would make this memo pointless.
  const schedules = useMemo(() => scheduleRows(records, new Date()), [records]);

  // The pane rather than the window: this is one cell of a split the user
  // drags, so how much room there is here says nothing about how much there is
  // anywhere else.
  const frameRef = useRef<HTMLDivElement>(null);
  const paneWidth = useElementWidth(frameRef);
  // The column's width rule depends on whether it is already up, so it has to
  // read its own last answer. Safe to write during render: the rule is monotone
  // in `shown`, so feeding an answer back in reproduces it - one pass reaches a
  // fixed point, and a second render with the same inputs cannot land anywhere
  // else.
  //
  // One ref for the column rather than one per card: the hysteresis is about
  // whether the conversation has already given up the width, which is a fact
  // about the pane. Two of them would let the cards answer it differently and
  // put the column in and out from under each other.
  const shownRef = useRef(false);
  const todoCard = showTodoPanel(todos, {
    width: paneWidth,
    streaming,
    shown: shownRef.current
  });
  const subagentCard = showSubagentPanel(running, { width: paneWidth, shown: shownRef.current });
  const scheduleCard = showSchedulePanel(schedules, { width: paneWidth, shown: shownRef.current });
  const columned = todoCard || subagentCard || scheduleCard;
  shownRef.current = columned;
  const gutter = centeringGutterPx(paneWidth, columned);

  // Not only for the settings screen: the catalog carries the context limits,
  // and without them the pane cannot tell how full it is or compact on its own.
  // Loading it is idempotent and cached in main, so opening a pane is cheap.
  useEffect(() => {
    void loadModels();
    // The mic button hides until a key is known to be set, so the pane learns
    // whether one is before it can be mis-rendered as unavailable.
    void loadKey();
  }, [loadModels, loadKey]);

  // The thread this pane left behind. Reading it is what makes the pane the
  // same conversation after a restart rather than a new one in the same folder.
  useEffect(() => {
    if (sessionId === undefined) return;
    void openSession(paneId, sessionId, cwd);
  }, [openSession, paneId, sessionId, cwd]);

  // Sent here by something that wanted this pane looked at - a click on a
  // desktop notification, the palette's "needs you". Whatever it was asking
  // about is in the conversation, so that is what the pane comes back to.
  useEffect(() => {
    const handler = (event: Event): void => {
      if (!(event instanceof CustomEvent)) return;
      const detail = RefocusDetail.safeParse(event.detail);
      if (!detail.success || detail.data.paneId !== paneId) return;
      setView('agent');
    };
    document.addEventListener('fleet:refocus-pane', handler);
    return () => document.removeEventListener('fleet:refocus-pane', handler);
  }, [paneId]);

  // Whether there is a picture to read through decides whether the chrome
  // turns to glass; the floor underneath it stays painted either way.
  const hasBackgroundImage = resolveBackgroundSrc(terminalBackground, slideshowFrame) !== null;

  return (
    // The image is one canvas behind the whole window (see App), so this pane
    // only supplies its own ground over it - glass, at the same strength the
    // terminals use, so a window of mixed panes reads as one material. The
    // transcript is prose rather than a glanced-at stream, so it carries its own
    // scrim (see AgentThread) instead of thickening the whole pane.
    <div
      ref={frameRef}
      className="relative flex h-full w-full flex-col"
      style={{
        ...getGlassCssVars(hasBackgroundImage),
        backgroundColor: paneGround(
          'var(--fleet-bg)',
          hasBackgroundImage,
          terminalBackground?.paneTint ?? PANE_GLASS
        ),
        backdropFilter: paneBackdrop(
          hasBackgroundImage,
          terminalBackground?.paneFrost ?? 0,
          terminalBackground?.paneSaturation ?? 1
        )
      }}
    >
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
        <AgentTabs value={view} onChange={setView} />
        {view === 'agent' && (
          // The conversation and the work in flight side by side. The column
          // takes a fixed width and the conversation takes the rest, with a
          // matching gutter on the left so the reading column stays centered on
          // the pane when the column arrives - the tabs above it never move, and
          // a conversation that slid out from under them every time the agent
          // wrote a plan would read as the pane having been knocked askew.
          //
          // The gutter is empty space rather than a second column of cards: the
          // conversation is the pane's one subject and the width it reads at is
          // the setting worth protecting, so the room is spent on symmetry
          // rather than filled.
          <div className="flex min-h-0 flex-1">
            <div className="flex min-w-0 flex-1" style={{ paddingLeft: gutter }}>
              <AgentThread
                paneId={paneId}
                cwd={cwd}
                todosInPanel={todoCard}
                running={running}
                subagentsInPanel={subagentCard}
                schedules={schedules}
                schedulesInPanel={scheduleCard}
              />
            </div>
            {columned && (
              // A flex column rather than a block: it is what caps the cards at
              // the pane's height, by letting each shrink once there is more to
              // say than there is room for. The plan first and the subagents
              // under it - the plan is the steadier of the two, and a card that
              // comes and goes with every dispatch should not be the one that
              // moves the other down the pane each time.
              <div
                style={{ width: SIDE_COLUMN_WIDTH_PX }}
                className="flex shrink-0 flex-col gap-2 pt-2 pr-3 pb-3 pl-2"
              >
                {todoCard && <AgentTodoPanel items={todos} streaming={streaming} />}
                {subagentCard && (
                  <AgentSubagentPanel
                    running={running}
                    onStop={(taskId) => window.fleet.agent.cancelTask(taskId)}
                  />
                )}
                {scheduleCard && (
                  <AgentSchedulePanel rows={schedules} onCancel={(id) => void cancelSchedule(id)} />
                )}
              </div>
            )}
          </div>
        )}
        {view === 'sessions' && (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <AgentSessionsTab paneId={paneId} cwd={cwd} onResumed={() => setView('agent')} />
          </div>
        )}
        {view === 'settings' && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <AgentSettingsPanel cwd={cwd} />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The pane's own switcher, centered over the content it toggles. A pill track
 * rather than underlines: it reads as a control at any pane width, including
 * the narrow ones a vertical split produces.
 */
function AgentTabs({
  value,
  onChange
}: {
  value: AgentView;
  onChange: (view: AgentView) => void;
}): React.JSX.Element {
  const move = (delta: number): void => {
    const next =
      TABS[(TABS.findIndex((t) => t.value === value) + delta + TABS.length) % TABS.length];
    onChange(next.value);
  };

  return (
    <div className="flex shrink-0 justify-center px-3 pt-2.5 pb-1.5">
      <div
        role="tablist"
        aria-label="Agent pane view"
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          move(e.key === 'ArrowRight' ? 1 : -1);
        }}
        // The agent pane has no title bar, so this pill is the chrome that
        // carries the focus cue the other panes carry in their header: lit and
        // firmly edged when the pane has focus, quiet when it does not.
        className="flex items-center gap-0.5 rounded-lg border border-fleet-border bg-fleet-glass-surface p-0.5 backdrop-blur-md transition-colors group-data-[pane-active=true]/pane:border-fleet-border-strong group-data-[pane-active=true]/pane:bg-fleet-glass-surface-3"
      >
        {TABS.map(({ value: tab, label, Icon }) => {
          const selected = tab === value;
          return (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={selected}
              // Only the active tab is in the tab order; arrow keys move between
              // them, which is what a tablist is meant to do.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(tab)}
              className={`flex items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium transition-colors focus-ring ${
                selected
                  ? 'bg-fleet-glass-surface-3 text-fleet-text'
                  : 'text-fleet-text-muted hover:text-fleet-text-secondary'
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
