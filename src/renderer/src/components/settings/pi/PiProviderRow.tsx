import { useState } from 'react';
import type { PiModelsFile, PiProvider } from '../../../../../shared/pi-config-types';
import { PiProviderForm } from './PiProviderForm';
import { PiBedrockPanel } from './PiBedrockPanel';
import type { ProviderRowKind } from './lib/provider-ordering';

export type PiProviderRowProps = {
  id: string;
  label: string;
  kind: ProviderRowKind;
  statusText: string;
  dotColor: 'green' | 'amber' | 'grey';
  autoExpand?: boolean;

  // Only when kind === 'custom':
  customProvider?: PiProvider;
  allProviderIds?: string[];
  models?: PiModelsFile;
  onSaveCustom?: (id: string, provider: PiProvider) => Promise<void>;
  onDeleteCustom?: (id: string) => Promise<void>;

  // Only when kind === 'managed-builtin' (Bedrock):
  legacyCustomProviderPresent?: boolean;
  onLegacyMigrate?: () => void | Promise<void>;
  onLegacyKeepAsCustom?: () => void;

  // Used by env-builtin-readonly rows to show which env var to set.
  envVarName?: string;
};

const dotClass: Record<PiProviderRowProps['dotColor'], string> = {
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  grey: 'bg-neutral-600'
};

export function PiProviderRow(props: PiProviderRowProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(Boolean(props.autoExpand));

  return (
    <div className="border border-neutral-800 rounded">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-neutral-900/40"
      >
        <span className={`w-2 h-2 rounded-full ${dotClass[props.dotColor]}`} aria-hidden />
        <span className="text-sm text-neutral-200 min-w-[140px]">{props.label}</span>
        {props.kind === 'custom' && (
          <span className="text-xs text-neutral-500 rounded bg-neutral-800 px-1.5 py-0.5">
            (c.)
          </span>
        )}
        <span className="text-xs text-neutral-500 flex-1">{props.statusText}</span>
        <span className="text-xs text-neutral-500">{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="border-t border-neutral-800">
          {props.kind === 'oauth-builtin' && <OAuthPanel label={props.label} />}
          {props.kind === 'env-builtin-readonly' && (
            <ReadonlyEnvPanel envVar={props.envVarName ?? ''} label={props.label} />
          )}
          {props.kind === 'managed-builtin' && (
            <PiBedrockPanel
              legacyCustomProviderPresent={props.legacyCustomProviderPresent ?? false}
              onLegacyMigrate={props.onLegacyMigrate ?? ((): void => undefined)}
              onLegacyKeepAsCustom={props.onLegacyKeepAsCustom ?? ((): void => undefined)}
            />
          )}
          {props.kind === 'custom' &&
            props.customProvider &&
            props.onSaveCustom &&
            props.onDeleteCustom &&
            props.allProviderIds && (
              <PiProviderForm
                initialId={props.id}
                initialProvider={props.customProvider}
                presetId="custom"
                existingIds={props.allProviderIds.filter((x) => x !== props.id)}
                onSave={async (nid, np) => props.onSaveCustom?.(nid, np)}
                onDelete={async () => props.onDeleteCustom?.(props.id)}
                onCancel={() => setExpanded(false)}
              />
            )}
        </div>
      )}
    </div>
  );
}

function OAuthPanel({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="px-3 py-3 text-sm text-neutral-300 space-y-2">
      <p>{label} uses OAuth. Sign in via the pi CLI:</p>
      <code className="block rounded bg-neutral-900 px-2 py-1 text-xs text-neutral-200">pi</code>
      <p className="text-xs text-neutral-500">
        Then type <code>/login</code> and follow the prompts. Come back here afterwards — auth
        status refreshes on window focus.
      </p>
    </div>
  );
}

function ReadonlyEnvPanel({ envVar, label }: { envVar: string; label: string }): React.JSX.Element {
  return (
    <div className="px-3 py-3 text-sm text-neutral-300 space-y-2">
      <p>
        {label} uses an environment variable
        {envVar ? (
          <>
            {' — set '}
            <code>{envVar}</code> in the shell you launch Fleet from.
          </>
        ) : (
          '.'
        )}
      </p>
      <p className="text-xs text-neutral-500">
        Fleet-managed injection for this provider isn&apos;t available yet.
      </p>
    </div>
  );
}
