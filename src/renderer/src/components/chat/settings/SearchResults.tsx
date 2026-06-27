import { CornerDownLeft } from 'lucide-react';
import { CHAT_SETTINGS_INDEX, CHAT_SETTINGS_SECTIONS, type ChatSettingsSection } from './sections';

const SECTION_BY_ID = new Map(CHAT_SETTINGS_SECTIONS.map((s) => [s.id, s]));

export function SearchResults({
  query,
  onPick
}: {
  query: string;
  onPick: (section: ChatSettingsSection) => void;
}): React.JSX.Element {
  const q = query.trim().toLowerCase();
  const matches = CHAT_SETTINGS_INDEX.filter((e) => {
    const section = SECTION_BY_ID.get(e.sectionId);
    const hay = `${e.label} ${e.keywords ?? ''} ${section?.label ?? ''}`.toLowerCase();
    return hay.includes(q);
  });

  if (matches.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-fleet-text-muted">
        No settings match “{query}”.
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="mb-3 text-xs text-fleet-text-subtle">
        {matches.length} result{matches.length === 1 ? '' : 's'}
      </p>
      {matches.map((e, i) => {
        const section = SECTION_BY_ID.get(e.sectionId);
        const Icon = section?.icon;
        return (
          <button
            key={`${e.sectionId}-${i}`}
            type="button"
            onClick={() => onPick(e.sectionId)}
            className="group flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors hover:bg-fleet-surface-2"
          >
            {Icon && <Icon size={15} className="shrink-0 text-fleet-text-muted" />}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-fleet-text">{e.label}</span>
              <span className="block truncate text-xs text-fleet-text-subtle">
                {section?.label}
              </span>
            </span>
            <CornerDownLeft
              size={13}
              className="shrink-0 text-fleet-text-subtle opacity-0 transition-opacity group-hover:opacity-100"
            />
          </button>
        );
      })}
    </div>
  );
}
