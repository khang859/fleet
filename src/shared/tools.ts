// Registry of the pinned "Tools" that appear in the sidebar Tools section.
// Visibility is a global preference stored in FleetSettings.tools.

export type ToolType = 'annotate' | 'sessions' | 'scratch';

export type ToolVisibility = Record<ToolType, boolean>;

export type ToolDefinition = {
  type: ToolType;
  label: string;
  description: string;
  /** Marks the tool as experimental in the picker. */
  experimental?: boolean;
};

/**
 * Default tool visibility: Annotate and Scratch on, everything else opt-in.
 *
 * Scratch is on because it is the only way to reach a conversation without
 * picking a folder first, and a quick chat nobody can find is not a quick chat.
 * It costs nothing while it sits there: no process, no watcher beyond the git
 * lookup every agent pane already does, which answers instantly for a folder
 * that is not a repository.
 */
export const DEFAULT_TOOL_VISIBILITY: ToolVisibility = {
  annotate: true,
  sessions: false,
  scratch: true
};

/** Render order in the Tools picker modal. */
export const TOGGLEABLE_TOOLS: readonly ToolDefinition[] = [
  { type: 'annotate', label: 'Annotate', description: 'Capture and mark up web pages.' },
  { type: 'sessions', label: 'Sessions', description: 'Browse and resume saved agent sessions.' },
  { type: 'scratch', label: 'Scratch', description: 'A quick chat that needs no project folder.' }
];
