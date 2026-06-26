import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import type {
  McpServersConfig,
  McpServerConfig,
  McpServerStatus,
  McpConnectionState
} from '../../../../shared/mcp-types';

const DOT: Record<McpConnectionState, string> = {
  connected: 'bg-green-400',
  connecting: 'bg-yellow-400',
  failed: 'bg-red-400',
  disabled: 'bg-fleet-text-muted'
};

const PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"]
    }
  }
}`;

/** Coerce a pasted blob into server entries (accepts wrapped or bare form). */
function parseServers(text: string): McpServersConfig {
  const raw: unknown = JSON.parse(text);
  const obj = isRecord(raw) && isRecord(raw.mcpServers) ? raw.mcpServers : raw;
  if (!isRecord(obj)) throw new Error('Expected an object of servers');
  const out: McpServersConfig = {};
  for (const [name, cfg] of Object.entries(obj)) {
    if (isRecord(cfg)) out[name] = toServerConfig(cfg);
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : undefined;
}

function strRecord(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
  return out;
}

/** Map a pasted record to a typed server config; unknown fields are dropped. */
function toServerConfig(cfg: Record<string, unknown>): McpServerConfig {
  return {
    enabled: true,
    command: typeof cfg.command === 'string' ? cfg.command : undefined,
    args: strArray(cfg.args),
    env: strRecord(cfg.env),
    url: typeof cfg.url === 'string' ? cfg.url : undefined,
    headers: strRecord(cfg.headers)
  };
}

export function McpServersTab(): React.JSX.Element {
  const [config, setConfig] = useState<McpServersConfig>({});
  const [statuses, setStatuses] = useState<McpServerStatus[]>([]);
  const [json, setJson] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = async (): Promise<void> => {
    const s = await window.fleet.chat.getSettings();
    setConfig(s.mcpServers);
    setStatuses(await window.fleet.chat.mcpGet());
  };

  useEffect(() => {
    void load();
  }, []);

  const apply = async (next: McpServersConfig): Promise<void> => {
    setConfig(next);
    setStatuses(await window.fleet.chat.mcpSet(next));
  };

  const toggle = (name: string): void => {
    void apply({ ...config, [name]: { ...config[name], enabled: !config[name].enabled } });
  };

  const remove = (name: string): void => {
    const next = { ...config };
    delete next[name];
    void apply(next);
  };

  const add = (): void => {
    try {
      const parsed = parseServers(json);
      void apply({ ...config, ...parsed });
      setJson('');
      setError(null);
    } catch {
      setError('Invalid JSON. Paste a standard mcpServers config.');
    }
  };

  const statusOf = (name: string): McpServerStatus | undefined =>
    statuses.find((s) => s.name === name);

  const names = Object.keys(config);

  return (
    <div className="space-y-3">
      {names.length === 0 && (
        <p className="text-xs text-fleet-text-muted">
          No MCP servers yet. Paste a config below to add one.
        </p>
      )}
      {names.map((name) => {
        const st = statusOf(name);
        const state = st?.state ?? (config[name].enabled ? 'connecting' : 'disabled');
        return (
          <div key={name} className="rounded border border-fleet-border bg-fleet-surface-2 p-2">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} />
              <span className="min-w-0 flex-1 truncate text-sm text-fleet-text">{name}</span>
              <span className="text-[11px] text-fleet-text-muted">{st?.toolCount ?? 0} tools</span>
              <label className="flex items-center gap-1 text-[11px] text-fleet-text-secondary">
                <input
                  type="checkbox"
                  checked={config[name].enabled}
                  onChange={() => toggle(name)}
                />
                Enabled
              </label>
              <button
                type="button"
                onClick={() => remove(name)}
                className="text-fleet-text-muted hover:text-red-400"
                aria-label={`Remove ${name}`}
              >
                <Trash2 size={13} />
              </button>
            </div>
            {st?.error && <p className="mt-1 text-[11px] text-red-400">{st.error}</p>}
            {st && st.tools.length > 0 && (
              <p className="mt-1 truncate text-[11px] text-fleet-text-muted">
                {st.tools.map((t) => t.name).join(', ')}
              </p>
            )}
          </div>
        );
      })}

      <div>
        <p className="mb-1 text-xs text-fleet-text-secondary">Add servers (paste JSON)</p>
        <textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          placeholder={PLACEHOLDER}
          rows={6}
          className="w-full rounded border border-fleet-border bg-fleet-surface-2 p-2 font-mono text-[11px] text-fleet-text outline-none placeholder:text-fleet-text-muted"
        />
        {error && <p className="mt-1 text-[11px] text-red-400">{error}</p>}
        <button
          type="button"
          onClick={add}
          disabled={!json.trim()}
          className="mt-1 rounded bg-fleet-accent/80 px-3 py-1 text-xs text-white disabled:opacity-50"
        >
          Add
        </button>
        <p className="mt-1 text-[11px] text-fleet-text-muted">
          Use <code>${'{VAR}'}</code> for secrets — expanded from your environment, never stored in
          the config.
        </p>
      </div>
    </div>
  );
}
