import type { BuiltInProviderStatus } from '../../../../../shared/pi-config-types';

type Props = { items: BuiltInProviderStatus[] };

export function PiBuiltInProvidersList({ items }: Props): React.JSX.Element {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold text-neutral-200">Built-in Providers</h2>
      <p className="text-xs text-neutral-500">
        Status is read-only. Run <code>pi</code> and use <code>/login</code> for OAuth providers, or set env vars for API-key providers.
      </p>
      <ul className="divide-y divide-neutral-800 border border-neutral-800 rounded">
        {items.map((p) => (
          <li key={p.id} className="flex items-center gap-3 px-3 py-2">
            <span
              className={`w-2 h-2 rounded-full ${
                p.authenticated ? 'bg-green-500' : 'bg-neutral-600'
              }`}
            />
            <span className="text-sm text-neutral-200 min-w-[140px]">{p.label}</span>
            <span className="text-xs text-neutral-500 flex-1">
              {p.method === 'oauth' && 'Authenticated via OAuth'}
              {p.method === 'env-var' && p.envVarName && `${p.envVarName} set`}
              {p.method === 'none' &&
                (p.envVarName ? `Not configured (set ${p.envVarName} or run /login)` : 'Not configured')}
            </span>
            {p.hint && (
              <span className="text-xs text-neutral-600" title={p.hint}>
                ?
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
