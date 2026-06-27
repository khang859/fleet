import {
  Boxes,
  MessagesSquare,
  Drama,
  Paperclip,
  Wrench,
  Globe,
  Gauge,
  Blocks,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react';

export type ChatSettingsSection =
  | 'models'
  | 'conversations'
  | 'personas'
  | 'composer'
  | 'agent'
  | 'webSearch'
  | 'usage'
  | 'extensions'
  | 'danger';

export type SectionMeta = {
  id: ChatSettingsSection;
  label: string;
  icon: LucideIcon;
  /** Rendered apart, at the bottom of the rail, with a danger accent. */
  danger?: boolean;
};

export const CHAT_SETTINGS_SECTIONS: SectionMeta[] = [
  { id: 'models', label: 'Models', icon: Boxes },
  { id: 'conversations', label: 'Conversations', icon: MessagesSquare },
  { id: 'personas', label: 'Personas', icon: Drama },
  { id: 'composer', label: 'Composer', icon: Paperclip },
  { id: 'agent', label: 'Agent & Tools', icon: Wrench },
  { id: 'webSearch', label: 'Web Search', icon: Globe },
  { id: 'usage', label: 'Usage & Cost', icon: Gauge },
  { id: 'extensions', label: 'Extensions', icon: Blocks },
  { id: 'danger', label: 'Danger Zone', icon: TriangleAlert, danger: true }
];

/** Flat index of individual settings, used to power search-to-jump. */
export type SettingsIndexEntry = {
  sectionId: ChatSettingsSection;
  label: string;
  keywords?: string;
};

export const CHAT_SETTINGS_INDEX: SettingsIndexEntry[] = [
  {
    sectionId: 'models',
    label: 'OpenRouter API key',
    keywords: 'token credential secret provider'
  },
  { sectionId: 'models', label: 'Default model', keywords: 'chat llm' },
  { sectionId: 'models', label: 'Image model', keywords: 'image generation picture' },
  { sectionId: 'conversations', label: 'Auto-name conversations', keywords: 'title naming' },
  { sectionId: 'conversations', label: 'Naming model', keywords: 'task title cheap' },
  { sectionId: 'conversations', label: 'Naming timing', keywords: 'title when' },
  { sectionId: 'conversations', label: 'Auto-tag conversations', keywords: 'labels topics' },
  {
    sectionId: 'conversations',
    label: 'Default sort',
    keywords: 'order recent alphabetical sidebar'
  },
  { sectionId: 'conversations', label: 'Export format', keywords: 'markdown json download' },
  { sectionId: 'personas', label: 'Personas', keywords: 'system prompt preset persona' },
  { sectionId: 'composer', label: 'Allowed attachments', keywords: 'pdf image upload file' },
  { sectionId: 'composer', label: 'Max attachment size', keywords: 'upload limit mb file' },
  { sectionId: 'composer', label: '@-mention file size limit', keywords: 'context pin repo kb' },
  { sectionId: 'agent', label: 'Tools mode', keywords: 'bash shell read-only ask auto permission' },
  { sectionId: 'agent', label: 'Permission rules', keywords: 'allow ask deny gate tool' },
  { sectionId: 'agent', label: 'Workspace directory', keywords: 'cwd sandbox root path' },
  { sectionId: 'agent', label: 'Sandbox', keywords: 'bubblewrap isolate shell fail closed' },
  { sectionId: 'webSearch', label: 'Enable web search', keywords: 'tool internet lookup' },
  { sectionId: 'webSearch', label: 'Search provider', keywords: 'tavily exa brave' },
  { sectionId: 'webSearch', label: 'Search provider API key', keywords: 'credential secret' },
  { sectionId: 'webSearch', label: 'Max results', keywords: 'count limit' },
  { sectionId: 'usage', label: 'Cost meter', keywords: 'tokens spend price usage' },
  { sectionId: 'usage', label: 'Prompt caching', keywords: 'cache cost anthropic' },
  { sectionId: 'usage', label: 'Budget warning', keywords: 'limit spend dollars usd' },
  { sectionId: 'extensions', label: 'MCP servers', keywords: 'model context protocol tools' },
  { sectionId: 'extensions', label: 'Skills', keywords: 'know-how procedures' },
  { sectionId: 'extensions', label: 'Prompts', keywords: 'templates slash library' },
  { sectionId: 'danger', label: 'Reset Chat settings', keywords: 'defaults restore wipe' }
];
