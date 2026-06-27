import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { useChatSettings } from './use-chat-settings';
import { SectionShell } from './primitives';
import { DEFAULT_CHAT_SETTINGS } from '../../../../../shared/chat-types';

export function DangerZoneSection(): React.JSX.Element {
  const { patch } = useChatSettings();
  const [confirming, setConfirming] = useState(false);

  const reset = async (): Promise<void> => {
    // Reset preferences to defaults but re-supply current user content so it is
    // preserved (personas, prompts, MCP servers, skills). Read fresh settings
    // first — those collections are edited by sub-components that bypass this
    // context (PersonaManager, PromptLibraryTab, McpServersTab, SkillsTab), so
    // the context snapshot can be stale. API keys live in the encrypted secrets
    // store and are untouched.
    const fresh = await window.fleet.chat.getSettings();
    await patch({
      ...DEFAULT_CHAT_SETTINGS,
      personas: fresh.personas,
      defaultPersonaId: fresh.defaultPersonaId,
      prompts: fresh.prompts,
      mcpServers: fresh.mcpServers,
      skills: fresh.skills
    });
    setConfirming(false);
  };

  return (
    <SectionShell title="Danger Zone" description="Irreversible actions. Proceed with care.">
      <div className="rounded-lg border border-red-500/30 bg-red-500/[0.04] p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm font-medium text-fleet-text">Reset Chat settings</h3>
            <p className="mt-0.5 text-xs text-fleet-text-muted">
              Restore all preferences (models, tools, web search, usage, conversations) to their
              defaults. Your personas, prompts, MCP servers, skills, and saved API keys are kept.
            </p>
          </div>
          {confirming ? (
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-md px-3 py-1.5 text-sm text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 hover:text-fleet-text"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void reset()}
                className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition active:scale-[0.97] hover:bg-red-500"
              >
                Confirm reset
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-red-500/40 px-3 py-1.5 text-sm font-medium text-red-400 transition-colors hover:bg-red-500/10"
            >
              <RotateCcw size={14} /> Reset
            </button>
          )}
        </div>
      </div>
    </SectionShell>
  );
}
