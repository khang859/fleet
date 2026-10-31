import { RUNTIMES } from './session-runtimes';

/** The agents Fleet can start in a new worktree, and the command that starts each. */
export const WORKTREE_AGENTS = [
  { id: 'claude', label: RUNTIMES.claude.label, command: 'claude' },
  { id: 'pi', label: RUNTIMES.pi.label, command: 'pi' }
] as const;

type WorktreeAgentId = (typeof WORKTREE_AGENTS)[number]['id'];

/** What runs in a new worktree: nothing, a known agent, or the command set in Settings. */
export type AgentChoice = 'none' | 'custom' | WorktreeAgentId;

const AGENT_CHOICES: AgentChoice[] = ['none', 'custom', ...WORKTREE_AGENTS.map(({ id }) => id)];

export type AgentOption = {
  choice: AgentChoice;
  label: string;
  /** What to type into the shell; empty for none. */
  command: string;
};

/** A saved choice, or null when there is none this version of Fleet knows. */
export function readAgentChoice(saved: unknown): AgentChoice | null {
  return AGENT_CHOICES.find((choice) => choice === saved) ?? null;
}

/** The first agent someone starts becomes their default. None in Settings is a choice, so it stays. */
export function isFirstAgentPick(saved: AgentChoice | null, picked: AgentChoice): boolean {
  return saved === null && picked !== 'none';
}

/** What a worktree can start with. The custom command is listed once there is one. */
export function agentOptions(customCommand: string): AgentOption[] {
  const custom = customCommand.trim();
  const known = WORKTREE_AGENTS.map(({ id, label, command }) => ({ choice: id, label, command }));

  return [
    { choice: 'none', label: 'None', command: '' },
    ...known,
    ...(custom === '' ? [] : [{ choice: 'custom' as const, label: custom, command: custom }])
  ];
}

/**
 * The text to type into a new worktree's shell. The agent comes last, on its
 * own line, so the shell starts it once the setup is done, even a failed one.
 */
export function worktreeStartText(setup: string, agentCommand: string): string | undefined {
  return [setup, agentCommand].filter((part) => part !== '').join('\n') || undefined;
}
