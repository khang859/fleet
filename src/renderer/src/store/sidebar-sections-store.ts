import { create } from 'zustand';
import { z } from 'zod';

const STORAGE_KEY = 'fleet.sidebar-sections';

/**
 * The sidebar sections that fold away. The tab list above them is deliberately
 * not one - it is the reason the sidebar exists, and a sidebar whose contents
 * can be hidden entirely is a sidebar you would rather have closed.
 */
export const SIDEBAR_SECTIONS = ['agents', 'tools', 'workspaces'] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];

/**
 * Collapsed sections are stored, not expanded ones, so a section added later
 * starts open without a migration - an id absent from the list simply reads as
 * expanded. Unknown ids are dropped on read rather than rejecting the whole
 * list, so removing a section does not reset the user's other choices.
 */
const CollapsedSchema = z.array(z.string());

function load(): Set<SidebarSection> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const result = CollapsedSchema.safeParse(JSON.parse(raw));
    if (!result.success) return new Set();
    const known = new Set<string>(SIDEBAR_SECTIONS);
    return new Set(result.data.filter((id): id is SidebarSection => known.has(id)));
  } catch {
    return new Set();
  }
}

function persist(collapsed: Set<SidebarSection>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...collapsed]));
  } catch {
    // localStorage may be unavailable; the fold state is best-effort.
  }
}

type SidebarSectionsStore = {
  collapsed: Set<SidebarSection>;
  toggle: (section: SidebarSection) => void;
  /** Used by the section's own add buttons, so acting on a folded section shows the result. */
  expand: (section: SidebarSection) => void;
};

export const useSidebarSectionsStore = create<SidebarSectionsStore>((set, get) => ({
  collapsed: load(),
  toggle: (section) => {
    const next = new Set(get().collapsed);
    if (!next.delete(section)) next.add(section);
    persist(next);
    set({ collapsed: next });
  },
  expand: (section) => {
    const current = get().collapsed;
    if (!current.has(section)) return;
    const next = new Set(current);
    next.delete(section);
    persist(next);
    set({ collapsed: next });
  }
}));
