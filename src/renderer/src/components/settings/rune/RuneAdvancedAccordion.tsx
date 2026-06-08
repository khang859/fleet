import { useState } from 'react';
import { RuneText, RuneToggle } from './RuneControls';
import { RuneProfilesEditor } from './RuneProfilesEditor';
import { SettingRow } from '../SettingRow';
import type { RuneSettings } from '../../../../../shared/rune-config-types';

type Props = {
  settings: RuneSettings;
  onChange: (patch: Partial<RuneSettings>) => Promise<void> | void;
  onOpenConfigFolder: () => Promise<void> | void;
};

export function RuneAdvancedAccordion({
  settings,
  onChange,
  onOpenConfigFolder
}: Props): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const repoMap = settings.repo_map ?? {};

  return (
    <section className="border-t border-neutral-800 pt-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="text-sm text-neutral-300 hover:text-neutral-100 transition active:scale-[0.97]"
      >
        {open ? '▾' : '▸'} Advanced
      </button>
      {open && (
        <div className="mt-4 space-y-6">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Ollama
            </h3>
            <RuneText
              label="Endpoint"
              value={settings.ollama_endpoint ?? ''}
              placeholder="http://localhost:11434/api/chat"
              widthClass="w-72"
              onCommit={(v) => void onChange({ ollama_endpoint: v })}
            />
            <RuneText
              label="num_ctx"
              value={settings.ollama_num_ctx != null ? String(settings.ollama_num_ctx) : ''}
              placeholder="16384"
              widthClass="w-32"
              // Empty or non-numeric → 0, which rune normalizes back to its
              // default. undefined would be skipped by the merge (a no-op clear).
              onCommit={(v) => {
                const n = Number(v);
                void onChange({ ollama_num_ctx: v.trim() === '' || !Number.isFinite(n) ? 0 : n });
              }}
            />
            <RuneToggle
              label="Think"
              checked={settings.ollama_think ?? false}
              onChange={(checked) => void onChange({ ollama_think: checked })}
            />
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Endpoints
            </h3>
            <RuneText
              label="RunPod endpoint"
              value={settings.runpod_endpoint ?? ''}
              placeholder="model default"
              widthClass="w-72"
              onCommit={(v) => void onChange({ runpod_endpoint: v })}
            />
            <RuneText
              label="OpenRouter endpoint"
              value={settings.openrouter_endpoint ?? ''}
              placeholder="default"
              widthClass="w-72"
              onCommit={(v) => void onChange({ openrouter_endpoint: v })}
            />
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Repo map
            </h3>
            <RuneToggle
              label="Enabled"
              checked={repoMap.enabled ?? false}
              onChange={(checked) => void onChange({ repo_map: { enabled: checked } })}
            />
            <RuneText
              label="Max tokens"
              value={repoMap.max_tokens != null ? String(repoMap.max_tokens) : ''}
              placeholder="0"
              widthClass="w-32"
              onCommit={(v) => {
                const n = Number(v);
                void onChange({
                  repo_map: { max_tokens: v.trim() === '' || !Number.isFinite(n) ? 0 : n }
                });
              }}
            />
          </div>

          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
              Provider profiles
            </h3>
            <RuneProfilesEditor settings={settings} onChange={onChange} />
          </div>

          <SettingRow label="Config folder (~/.rune/)">
            <button
              type="button"
              onClick={() => void onOpenConfigFolder()}
              className="text-xs px-2 py-1 rounded border border-neutral-700 hover:bg-neutral-800 transition active:scale-[0.97]"
            >
              Open
            </button>
          </SettingRow>
          <p className="text-xs text-neutral-500">
            Rune reads these files on launch. If <code>rune</code> is running in a terminal, save
            from one side at a time.
          </p>
        </div>
      )}
    </section>
  );
}
