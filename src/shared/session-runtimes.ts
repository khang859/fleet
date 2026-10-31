import type { SessionRuntime } from './claude-sessions';

export type RuntimeProfile = {
  /** The program's name, as the UI shows it. */
  label: string;
  /** How a prompt reaches its input box; see `PromptInput`. */
  promptDelivery: 'type' | 'paste';
  /** The most it takes in one prompt, in bytes, when it has a limit. */
  maxPromptBytes?: number;
  /** The format of its session file, or null when it keeps none Fleet can read. */
  transcript: 'claude' | 'pi' | null;
  /** How a question dialog is answered: an option number sent to the pane, or by hand there. */
  questionAnswers: 'number' | 'terminal';
};

/** What differs between the programs Fleet tracks in its panes. */
export const RUNTIMES: Record<SessionRuntime, RuntimeProfile> = {
  claude: {
    label: 'Claude Code',
    promptDelivery: 'type',
    transcript: 'claude',
    questionAnswers: 'number'
  },
  eva: {
    label: 'eva',
    promptDelivery: 'paste',
    maxPromptBytes: 1_000_000,
    transcript: null,
    questionAnswers: 'number'
  },
  pi: { label: 'Pi', promptDelivery: 'paste', transcript: 'pi', questionAnswers: 'terminal' }
};

/** The names of the programs running these sessions, Claude Code when there are none. */
export function runtimesLabel(sessions: ReadonlyArray<{ runtime: SessionRuntime }>): string {
  const running = new Set(sessions.map((s) => RUNTIMES[s.runtime]));
  if (running.size === 0) return RUNTIMES.claude.label;
  return Object.values(RUNTIMES)
    .filter((runtime) => running.has(runtime))
    .map((runtime) => runtime.label)
    .join(' · ');
}
