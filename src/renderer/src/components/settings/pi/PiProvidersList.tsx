import { useEffect, useMemo, useState } from 'react';
import type {
  BuiltInProviderStatus,
  PiModelsFile,
  PiProvider
} from '../../../../../shared/pi-config-types';
import { PI_BUILT_IN_PROVIDERS, type PiPresetId } from '../../../../../shared/pi-presets';
import {
  orderProviderRows,
  type ProviderRowInput,
  type ProviderRowKind
} from './lib/provider-ordering';
import { PiProviderRow } from './PiProviderRow';
import { PiPresetPicker } from './PiPresetPicker';

type Props = {
  builtIn: BuiltInProviderStatus[];
  models: PiModelsFile;
  bedrockHasEnvConfig: boolean;
  autoExpandId: string | null;
  onExpandConsumed: () => void;
  onAddCustom: (presetId: PiPresetId) => void;
  onSaveCustom: (id: string, provider: PiProvider) => Promise<void>;
  onDeleteCustom: (id: string) => Promise<void>;
  onLegacyMigrate: () => Promise<void>;
  onLegacyKeepAsCustom: () => void;
};

function inferKind(id: string): ProviderRowKind {
  const meta = PI_BUILT_IN_PROVIDERS.find((p) => p.id === id);
  if (!meta) return 'custom';
  if (meta.managedEnv) return 'managed-builtin';
  if (meta.supportsOAuth) return 'oauth-builtin';
  return 'env-builtin-readonly';
}

function bedrockDot(
  status: BuiltInProviderStatus | undefined,
  hasEnvConfig: boolean
): 'green' | 'amber' | 'grey' {
  if (status?.authenticated) return 'green';
  if (hasEnvConfig) return 'amber';
  return 'grey';
}

export function PiProvidersList({
  builtIn,
  models,
  bedrockHasEnvConfig,
  autoExpandId,
  onExpandConsumed,
  onAddCustom,
  onSaveCustom,
  onDeleteCustom,
  onLegacyMigrate,
  onLegacyKeepAsCustom
}: Props): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [secondaryOpen, setSecondaryOpen] = useState(false);

  const legacyBedrockProvider: PiProvider | undefined = models.providers['bedrock'];

  const customIds = useMemo(() => {
    return Object.keys(models.providers).filter((id) => id !== 'bedrock');
  }, [models]);

  const rows: ProviderRowInput[] = useMemo(() => {
    const byId = new Map<string, BuiltInProviderStatus>();
    for (const s of builtIn) byId.set(s.id, s);

    const builtInRows: ProviderRowInput[] = PI_BUILT_IN_PROVIDERS.map((meta) => {
      const status = byId.get(meta.id);
      const authed = Boolean(status?.authenticated);
      return {
        id: meta.id,
        label: meta.label,
        kind: inferKind(meta.id),
        configured: meta.id === 'bedrock' ? authed || bedrockHasEnvConfig : authed
      };
    });

    const customRows: ProviderRowInput[] = customIds.map((id) => {
      const p = models.providers[id];
      return {
        id,
        label: id,
        kind: 'custom',
        configured: Boolean(p.apiKey || p.baseUrl)
      };
    });

    return [...builtInRows, ...customRows];
  }, [builtIn, models, customIds, bedrockHasEnvConfig]);

  const ordered = useMemo(() => orderProviderRows(rows), [rows]);

  // After the list re-renders with a row autoExpanded, clear the parent's autoExpand state
  // so subsequent state changes don't keep re-triggering expansion on the same row.
  useEffect(() => {
    if (autoExpandId !== null) {
      onExpandConsumed();
    }
  }, [autoExpandId, onExpandConsumed]);

  const renderRow = (row: ProviderRowInput): React.JSX.Element => {
    const status = builtIn.find((s) => s.id === row.id);
    const meta = PI_BUILT_IN_PROVIDERS.find((p) => p.id === row.id);
    const autoExpand = autoExpandId === row.id;
    let statusText = '';
    let dot: 'green' | 'amber' | 'grey' = 'grey';

    if (row.kind === 'oauth-builtin') {
      statusText = status?.authenticated
        ? 'OAuth'
        : status?.envVarName
          ? `Set ${status.envVarName} or run /login`
          : 'Not authenticated';
      dot = status?.authenticated ? 'green' : 'grey';
    } else if (row.kind === 'env-builtin-readonly') {
      statusText = status?.authenticated
        ? `${status.envVarName ?? meta?.envVar ?? 'env var'} set`
        : status?.envVarName
          ? `Set ${status.envVarName} in your shell`
          : meta?.envVar
            ? `Set ${meta.envVar} in your shell`
            : 'Not configured';
      dot = status?.authenticated ? 'green' : 'grey';
    } else if (row.kind === 'managed-builtin') {
      statusText = status?.authenticated
        ? 'Configured (env injection)'
        : bedrockHasEnvConfig
          ? 'Partial (needs region or creds)'
          : 'Not configured';
      dot = bedrockDot(status, bedrockHasEnvConfig);
    } else {
      const provider = models.providers[row.id];
      const modelCount = provider.models?.length ?? 0;
      statusText = modelCount ? `${modelCount} model${modelCount === 1 ? '' : 's'}` : 'custom';
      dot = provider.apiKey || provider.baseUrl ? 'green' : 'amber';
    }

    const common = {
      id: row.id,
      label: row.label,
      kind: row.kind,
      statusText,
      dotColor: dot,
      autoExpand,
      envVarName: status?.envVarName ?? meta?.envVar
    };

    if (row.kind === 'custom') {
      return (
        <div key={row.id}>
          <PiProviderRow
            {...common}
            customProvider={models.providers[row.id]}
            allProviderIds={Object.keys(models.providers)}
            models={models}
            onSaveCustom={onSaveCustom}
            onDeleteCustom={onDeleteCustom}
          />
        </div>
      );
    }
    if (row.kind === 'managed-builtin') {
      return (
        <div key={row.id}>
          <PiProviderRow
            {...common}
            legacyCustomProviderPresent={Boolean(legacyBedrockProvider)}
            onLegacyMigrate={onLegacyMigrate}
            onLegacyKeepAsCustom={onLegacyKeepAsCustom}
          />
        </div>
      );
    }
    return (
      <div key={row.id}>
        <PiProviderRow {...common} />
      </div>
    );
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-neutral-200">Providers</h2>
          <p className="text-xs text-neutral-500">
            Each provider needs credentials or an auth method. Click a row to configure.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 rounded text-white"
        >
          + Add custom
        </button>
      </div>

      <div className="space-y-2">
        {ordered.primary.map(renderRow)}
        {ordered.secondary.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => setSecondaryOpen((o) => !o)}
              className="text-xs text-neutral-400 hover:text-neutral-200 underline"
            >
              {secondaryOpen ? 'Hide' : `Show ${ordered.secondary.length} more providers`}
            </button>
            {secondaryOpen && <div className="space-y-2">{ordered.secondary.map(renderRow)}</div>}
          </>
        )}
      </div>

      {pickerOpen && (
        <PiPresetPicker
          onPick={(presetId) => {
            setPickerOpen(false);
            onAddCustom(presetId);
          }}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </section>
  );
}
