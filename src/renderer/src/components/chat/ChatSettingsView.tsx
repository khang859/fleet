import { useState } from 'react';
import { ChatSettingsProvider } from './settings/ChatSettingsContext';
import { ChatSettingsNav } from './settings/ChatSettingsNav';
import { SaveStatus } from './settings/SaveStatus';
import { SearchResults } from './settings/SearchResults';
import type { ChatSettingsSection } from './settings/sections';
import { ModelsSection } from './settings/ModelsSection';
import { ConversationsSection } from './settings/ConversationsSection';
import { PersonasSection } from './settings/PersonasSection';
import { ComposerSection } from './settings/ComposerSection';
import { AgentToolsSection } from './settings/AgentToolsSection';
import { WebSearchSection } from './settings/WebSearchSection';
import { UsageSection } from './settings/UsageSection';
import { ExtensionsSection } from './settings/ExtensionsSection';
import { DangerZoneSection } from './settings/DangerZoneSection';

const SECTION_COMPONENTS: Record<ChatSettingsSection, React.ComponentType> = {
  models: ModelsSection,
  conversations: ConversationsSection,
  personas: PersonasSection,
  composer: ComposerSection,
  agent: AgentToolsSection,
  webSearch: WebSearchSection,
  usage: UsageSection,
  extensions: ExtensionsSection,
  danger: DangerZoneSection
};

function ChatSettingsInner(): React.JSX.Element {
  const [active, setActive] = useState<ChatSettingsSection>('models');
  const [query, setQuery] = useState('');
  const searching = query.trim().length > 0;

  const goTo = (section: ChatSettingsSection): void => {
    setActive(section);
    setQuery('');
  };

  const Section = SECTION_COMPONENTS[active];

  return (
    <div className="flex h-full">
      <ChatSettingsNav active={active} onChange={goTo} query={query} onQueryChange={setQuery} />
      <div className="relative min-w-0 flex-1 overflow-y-auto">
        <div className="pointer-events-none sticky top-0 z-10 flex h-9 items-center justify-end bg-fleet-bg/80 px-6 backdrop-blur-sm">
          <SaveStatus />
        </div>
        <div className="mx-auto max-w-[640px] px-6 pb-12 pt-2">
          {searching ? <SearchResults query={query} onPick={goTo} /> : <Section />}
        </div>
      </div>
    </div>
  );
}

export function ChatSettingsView(): React.JSX.Element {
  return (
    <ChatSettingsProvider>
      <ChatSettingsInner />
    </ChatSettingsProvider>
  );
}
