import { useEffect, useState } from 'react';
import { RuneGeneralForm } from './RuneGeneralForm';
import { RuneSecretsForm } from './RuneSecretsForm';
import { RuneAdvancedAccordion } from './RuneAdvancedAccordion';
import type { RuneSettings, RuneSecrets } from '../../../../../shared/rune-config-types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; settings: RuneSettings; secrets: RuneSecrets }
  | { kind: 'error'; message: string };

export function RuneSettingsEditor(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [settings, secrets] = await Promise.all([
          window.fleet.rune.readSettings(),
          window.fleet.rune.readSecrets()
        ]);
        if (alive) setState({ kind: 'ready', settings, secrets });
      } catch (err) {
        if (alive)
          setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      }
    };
    void load();
    const onFocus = (): void => void load();
    window.addEventListener('focus', onFocus);
    return () => {
      alive = false;
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  const reload = async (): Promise<void> => {
    try {
      const [settings, secrets] = await Promise.all([
        window.fleet.rune.readSettings(),
        window.fleet.rune.readSecrets()
      ]);
      setState({ kind: 'ready', settings, secrets });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onSettingsChange = async (patch: Partial<RuneSettings>): Promise<void> => {
    await window.fleet.rune.writeSettings(patch);
    await reload();
  };

  const onSecretsChange = async (patch: Record<string, string>): Promise<void> => {
    await window.fleet.rune.writeSecrets(patch);
    await reload();
  };

  if (state.kind === 'loading') {
    return <div className="text-sm text-neutral-400">Loading rune settings…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded bg-red-900/30 border border-red-700/50 px-3 py-2 text-sm text-red-300">
        Failed to read rune settings: {state.message}
        <button
          onClick={() => void window.fleet.rune.openConfigFolder()}
          className="ml-2 underline transition active:scale-[0.97]"
        >
          Open config folder
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <RuneGeneralForm settings={state.settings} onChange={onSettingsChange} />
      <RuneSecretsForm secrets={state.secrets} onChange={onSecretsChange} />
      <RuneAdvancedAccordion
        settings={state.settings}
        onChange={onSettingsChange}
        onOpenConfigFolder={() => void window.fleet.rune.openConfigFolder()}
      />
    </div>
  );
}
