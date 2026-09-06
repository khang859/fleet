// Registry of pinned sidebar tools.
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

/** Scratch's legacy preference is retained for settings compatibility only. */
export const DEFAULT_TOOL_VISIBILITY: ToolVisibility = {
  annotate: true,
  sessions: false,
  scratch: true
};

/** Render order in the Tools picker modal. */
export const TOGGLEABLE_TOOLS: readonly ToolDefinition[] = [
  { type: 'annotate', label: 'Annotate', description: 'Capture and mark up web pages.' },
  { type: 'sessions', label: 'Sessions', description: 'Browse and resume saved agent sessions.' }
];
