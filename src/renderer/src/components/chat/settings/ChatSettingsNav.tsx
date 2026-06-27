import { Search, X } from 'lucide-react';
import { CHAT_SETTINGS_SECTIONS, type ChatSettingsSection } from './sections';
import { inputCls } from './controls';

export function ChatSettingsNav({
  active,
  onChange,
  query,
  onQueryChange
}: {
  active: ChatSettingsSection;
  onChange: (section: ChatSettingsSection) => void;
  query: string;
  onQueryChange: (q: string) => void;
}): React.JSX.Element {
  const primary = CHAT_SETTINGS_SECTIONS.filter((s) => !s.danger);
  const danger = CHAT_SETTINGS_SECTIONS.filter((s) => s.danger);

  const itemCls = (id: ChatSettingsSection, isDanger?: boolean): string => {
    const isActive = active === id && !query;
    if (isActive) {
      return `flex w-full items-center gap-2 rounded-md border-l-2 fleet-accent-border bg-fleet-surface-2 py-1.5 pl-[6px] pr-2 text-left text-sm text-fleet-text transition-colors active:scale-[0.98]`;
    }
    return `flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors active:scale-[0.98] ${
      isDanger
        ? 'text-red-400/80 hover:bg-red-500/10 hover:text-red-300'
        : 'text-fleet-text-muted hover:bg-fleet-surface-2 hover:text-fleet-text'
    }`;
  };

  return (
    <nav className="flex w-[200px] shrink-0 flex-col gap-0.5 border-r border-fleet-border bg-fleet-surface/40 p-3">
      <div className="relative mb-2">
        <Search
          size={13}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fleet-text-subtle"
        />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search settings"
          className={`${inputCls} w-full py-1 pl-7 pr-7 text-xs`}
        />
        {query && (
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
            className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-fleet-text-subtle transition-colors hover:text-fleet-text"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {primary.map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => onChange(id)} className={itemCls(id)}>
          <Icon size={15} className="shrink-0 opacity-80" />
          {label}
        </button>
      ))}

      <div className="my-1 border-t border-fleet-border" />

      {danger.map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => onChange(id)} className={itemCls(id, true)}>
          <Icon size={15} className="shrink-0 opacity-80" />
          {label}
        </button>
      ))}
    </nav>
  );
}
