import { useEffect, useState } from 'react';
import type {
  PiSettings,
  PiModelsFile,
  BuiltInProviderStatus
} from '../../../../../shared/pi-config-types';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; settings: PiSettings; models: PiModelsFile; builtIn: BuiltInProviderStatus[] }
  | { kind: 'error'; message: string };

export function PiSection(): React.JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const [settings, models, builtIn] = await Promise.all([
          window.fleet.piConfig.readSettings(),
          window.fleet.piConfig.readModels(),
          window.fleet.piConfig.getBuiltInStatus()
        ]);
        if (!alive) return;
        setState({ kind: 'ready', settings, models, builtIn });
      } catch (err) {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
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

  if (state.kind === 'loading') {
    return <div className="text-sm text-neutral-400">Loading pi configuration…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="rounded bg-red-900/30 border border-red-700/50 px-3 py-2 text-sm text-red-300">
        Failed to read pi config: {state.message}
        <button
          onClick={() => void window.fleet.piConfig.openConfigFolder()}
          className="ml-2 underline"
        >
          Open config folder
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h1 className="text-xl text-neutral-100 font-semibold">Pi Agent</h1>
      <p className="text-sm text-neutral-500">
        Configure pi-coding-agent. Writes to <code>~/.pi/agent/</code>; changes apply to both Fleet&apos;s pi tabs and your CLI pi.
      </p>
      <PiConfigStub settings={state.settings} models={state.models} builtIn={state.builtIn} />
      <footer className="pt-4 border-t border-neutral-800 text-xs text-neutral-500 flex justify-between">
        <span>Pi CLI writes the same files. If <code>pi</code> is open, save from one side at a time.</span>
        <button
          onClick={() => void window.fleet.piConfig.openConfigFolder()}
          className="underline hover:text-neutral-300"
        >
          Open config folder
        </button>
      </footer>
    </div>
  );
}

function PiConfigStub({
  settings,
  models,
  builtIn
}: {
  settings: PiSettings;
  models: PiModelsFile;
  builtIn: BuiltInProviderStatus[];
}): React.JSX.Element {
  return (
    <pre className="text-xs text-neutral-400 bg-neutral-900 rounded p-3 overflow-x-auto">
      {JSON.stringify({ settings, providerIds: Object.keys(models.providers), builtIn }, null, 2)}
    </pre>
  );
}
