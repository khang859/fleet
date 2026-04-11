// src/renderer/src/components/Telescope/types.ts
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

export type TelescopeItem = {
  id: string;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  meta?: string;
  /** Arbitrary data the mode needs for onSelect/renderPreview (file path, line number, pane id, etc.) */
  data?: Record<string, unknown>;
};

export type TelescopeMode = {
  id: string;
  label: string;
  icon: LucideIcon;
  placeholder: string;
  onSearch: (query: string) => Promise<TelescopeItem[]> | TelescopeItem[];
  renderPreview: (item: TelescopeItem) => ReactNode;
  onSelect: (item: TelescopeItem) => void;
  onAltSelect?: (item: TelescopeItem) => void;
  /** Browse mode only: current path segments for breadcrumb display */
  breadcrumbs?: string[];
  /** Browse mode only: drill into a directory or jump to a breadcrumb path */
  onNavigate?: (dir: string) => void;
  /** Browse mode only: go up one directory */
  onNavigateUp?: () => void;
};
