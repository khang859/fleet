export type ProviderRowKind =
  | 'oauth-builtin'
  | 'managed-builtin'
  | 'env-builtin-readonly'
  | 'custom';

export type ProviderRowInput = {
  id: string;
  label: string;
  kind: ProviderRowKind;
  configured: boolean;
};

export type OrderedProviderRows<T extends ProviderRowInput> = {
  primary: T[];
  secondary: T[];
};

const PRIMARY_BUILTIN_IDS = new Set([
  'anthropic',
  'bedrock',
  'google',
  'ollama',
  'openai',
  'openrouter'
]);

export function orderProviderRows<T extends ProviderRowInput>(rows: T[]): OrderedProviderRows<T> {
  const primary: T[] = [];
  const secondary: T[] = [];

  for (const row of rows) {
    const isPrimaryTier =
      row.configured || row.kind === 'custom' || PRIMARY_BUILTIN_IDS.has(row.id);
    if (isPrimaryTier) {
      primary.push(row);
    } else {
      secondary.push(row);
    }
  }

  const byLabel = (a: T, b: T): number => a.label.localeCompare(b.label);
  primary.sort(byLabel);
  secondary.sort(byLabel);

  return { primary, secondary };
}
