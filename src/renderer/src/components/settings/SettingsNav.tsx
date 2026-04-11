export type SettingsSection = 'general' | 'notifications' | 'socket' | 'visualizer' | 'updates' | 'copilot' | 'annotate';

const ALL_SECTIONS: Array<{ id: SettingsSection; label: string; darwinOnly?: boolean }> = [
  { id: 'general', label: 'General' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'socket', label: 'Socket API' },
  { id: 'visualizer', label: 'Visualizer' },
  { id: 'copilot', label: 'Copilot', darwinOnly: true },
  { id: 'annotate', label: 'Annotate' },
  { id: 'updates', label: 'Updates' } // Always keep at bottom
];

const SECTIONS = ALL_SECTIONS.filter(
  (s) => !s.darwinOnly || window.fleet.platform === 'darwin'
);

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
      {SECTIONS.map((section) => (
        <button
          key={section.id}
          onClick={() => onChange(section.id)}
          className={`w-full text-left px-2 py-1.5 text-sm rounded-md transition-colors ${
            active === section.id
              ? 'text-white bg-neutral-800 border-l-2 border-blue-500 pl-[6px]'
              : 'text-neutral-400 hover:text-white hover:bg-neutral-800/50'
          }`}
        >
          {section.label}
        </button>
      ))}
    </nav>
  );
}
