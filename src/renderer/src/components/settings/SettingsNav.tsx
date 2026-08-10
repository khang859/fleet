export type SettingsSection =
  | 'general'
  | 'notifications'
  | 'socket'
  | 'visualizer'
  | 'updates'
  | 'copilot'
  | 'annotate'
  | 'envSync'
  | 'remoteHosts'
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
      { id: 'learnings', label: 'Learnings' },
      { id: 'visualizer', label: 'Visualizer' },
      { id: 'annotate', label: 'Annotate' },
      { id: 'envSync', label: 'Env Sync' }
    ]
  },
  {
    heading: 'Advanced',
    items: [
      { id: 'remoteHosts', label: 'Remote Hosts' },
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
    <nav className="w-[200px] shrink-0 border-r border-fleet-border p-3 space-y-0.5">
      {/* The tab is already labelled "Settings" in the sidebar and the title
          bar, so the old heading here was the third copy of the word on screen.
          Sentence-case group headers, like every other list in the app. */}
      {GROUPS.map((group) => (
        <div key={group.heading} className="pt-3 first:pt-0">
          <div className="text-[11px] font-medium text-fleet-text-subtle px-2 pb-1">
            {group.heading}
          </div>
          {group.items.map((section) => (
            <button
              key={section.id}
              onClick={() => onChange(section.id)}
              className={`w-full text-left border-l-2 pl-[6px] pr-2 py-1.5 text-sm rounded-md transition-colors ${
                active === section.id
                  ? 'text-fleet-text bg-fleet-surface-3 fleet-accent-border'
                  : 'text-fleet-text-secondary border-l-transparent hover:text-fleet-text hover:bg-fleet-surface-2'
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
