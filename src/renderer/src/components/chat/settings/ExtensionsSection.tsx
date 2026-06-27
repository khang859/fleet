import { useState } from 'react';
import { McpServersTab } from '../McpServersTab';
import { SkillsTab } from '../SkillsTab';
import { PromptLibraryTab } from '../PromptLibraryTab';
import { SectionShell } from './primitives';

type ExtensionsTab = 'mcp' | 'skills' | 'prompts';

const TABS: Array<{ id: ExtensionsTab; label: string }> = [
  { id: 'mcp', label: 'MCP Servers' },
  { id: 'skills', label: 'Skills' },
  { id: 'prompts', label: 'Prompts' }
];

export function ExtensionsSection(): React.JSX.Element {
  const [tab, setTab] = useState<ExtensionsTab>('mcp');

  return (
    <SectionShell
      title="Extensions"
      description="MCP adds tools (connectivity), Skills add know-how (procedures), and they compose."
    >
      <div className="inline-flex gap-0.5 rounded-lg border border-fleet-border bg-fleet-surface-2 p-0.5">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              tab === id
                ? 'bg-fleet-surface-3 text-fleet-text shadow-sm'
                : 'text-fleet-text-muted hover:text-fleet-text'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div>
        {tab === 'mcp' && <McpServersTab />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'prompts' && <PromptLibraryTab />}
      </div>
    </SectionShell>
  );
}
