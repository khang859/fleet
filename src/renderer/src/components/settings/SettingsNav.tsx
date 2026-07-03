export type SettingsSection =
  | 'general'
  | 'notifications'
  | 'socket'
  | 'visualizer'
  | 'updates'
  | 'copilot'
  | 'annotate'
  | 'rune'
  | 'pi'
  | 'kanban'
  | 'envSync'
  | 'learnings'
  | 'diagnostics';

type NavGroup = {
  heading: string;
  items: Array<{ id: SettingsSection; label: string; darwinOnly?: boolean }>;
};

// Grouped so app-level, per-tool, and developer-plumbing pages are scannable
// rather than interleaved in one flat list. Updates stays last (footer-y).
const NAV_GROUPS: NavGroup[] = [
  {
    heading: 'Application',
    items: [
      { id: 'general', label: 'General' },
      { id: 'notifications', label: 'Notifications' }
    ]
  },
  {
    heading: 'Tools & Agents',
    items: [
      { id: 'copilot', label: 'Copilot', darwinOnly: true },
      { id: 'rune', label: 'Rune' },
      { id: 'pi', label: 'Pi Agent' },
      { id: 'kanban', label: 'Kanban' },
      { id: 'learnings', label: 'Learnings' },
      { id: 'visualizer', label: 'Visualizer' },
      { id: 'annotate', label: 'Annotate' },
      { id: 'envSync', label: 'Env Sync' }
    ]
  },
  {
    heading: 'Advanced',
    items: [
      { id: 'socket', label: 'Socket API' },
      { id: 'diagnostics', label: 'Diagnostics' },
      { id: 'updates', label: 'Updates' }
    ]
  }
];

const GROUPS = NAV_GROUPS.map((g) => ({
  ...g,
  items: g.items.filter((s) => !s.darwinOnly || window.fleet.platform === 'darwin')
})).filter((g) => g.items.length > 0);

export function SettingsNav({
  active,
  onChange
}: {
  active: SettingsSection;
  onChange: (section: SettingsSection) => void;
}): React.JSX.Element {
  return (
    <nav className="w-[200px] shrink-0 border-r border-neutral-800 bg-neutral-900/50 p-3 space-y-0.5">
      <div className="text-xs text-neutral-500 uppercase tracking-wider px-2 py-1.5 mb-1">
        Settings
      </div>
      {GROUPS.map((group) => (
        <div key={group.heading} className="pt-2 first:pt-0">
          <div className="text-[10px] font-medium text-neutral-600 uppercase tracking-wider px-2 pb-1">
            {group.heading}
          </div>
          {group.items.map((section) => (
            <button
              key={section.id}
              onClick={() => onChange(section.id)}
              className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors active:scale-[0.97] ${
                active === section.id
                  ? 'text-white bg-neutral-800 border-l-2 fleet-accent-border pl-[6px]'
                  : 'text-neutral-400 hover:text-white hover:bg-neutral-800/50'
              }`}
            >
              {section.label}
            </button>
          ))}
        </div>
      ))}
    </nav>
  );
}
