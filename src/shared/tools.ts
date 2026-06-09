// Registry of the pinned "Tools" that appear in the sidebar Tools section.
// Visibility is a global preference stored in FleetSettings.tools.

export type ToolType = 'annotate' | 'kanban' | 'images' | 'sessions';

export type ToolVisibility = Record<ToolType, boolean>;

export type ToolDefinition = {
  type: ToolType;
  label: string;
  description: string;
  /** Marks the tool as experimental in the picker. */
  experimental?: boolean;
};

/** Default tool visibility: Annotate on, everything else opt-in. */
export const DEFAULT_TOOL_VISIBILITY: ToolVisibility = {
  annotate: true,
  kanban: false,
  images: false,
  sessions: false
};

/** Render order in the Tools picker modal. */
export const TOGGLEABLE_TOOLS: readonly ToolDefinition[] = [
  { type: 'annotate', label: 'Annotate', description: 'Capture and mark up web pages.' },
  {
    type: 'kanban',
    label: 'Kanban',
    description: 'Orchestrate AI agent tasks on a board.',
    experimental: true
  },
  { type: 'images', label: 'Images', description: 'Generate and browse images.' },
  { type: 'sessions', label: 'Sessions', description: 'Browse and resume saved agent sessions.' }
];
