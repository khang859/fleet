import { useEffect, useState } from 'react';
import { Plug } from 'lucide-react';
import type { McpAuth, McpServerConfig } from '../../../../../../shared/agent-mcp';
import { transportOf } from '../../../../../../shared/agent-mcp';
import { Overlay } from '../../../Overlay';
import { inputCls, selectCls } from '../../../chat/settings/controls';
import { SecretInput } from '../../../chat/settings/SecretInput';
import { Field } from '../../../chat/settings/primitives';
import {
  formatEnv,
  formatHeaders,
  parseArgs,
  parseEnv,
  parseHeaders,
  parsePasted
} from './config-text';

/**
 * Adding a server, or editing one that is already there.
 *
 * Two ways in, because there are two kinds of user here: someone following a
 * README, who has a JSON blob on the clipboard and wants it to just work, and
 * someone who knows what they want and would rather fill in four fields than
 * hand-write JSON. The paste tab exists so the first person never has to
 * translate, which is the step everything else in this feature is about
 * avoiding.
 */

type Tab = 'form' | 'paste';
type Transport = 'stdio' | 'http';

/** What the dialog hands back: the servers to write, and any token to store. */
export type McpDraft = {
  /** The name being replaced, when this was an edit that renamed one. */
  replacing: string | null;
  servers: Record<string, McpServerConfig>;
  /** `undefined` leaves whatever is stored alone; `null` clears it. */
  token?: string | null;
};

export function McpAddDialog({
  open,
  editing,
  takenNames,
  onCancel,
  onSave
}: {
  open: boolean;
  /** The server being edited, or null when this is a new one. */
  editing: { name: string; config: McpServerConfig; hasCredential: boolean } | null;
  /** Names already in use, so a new server cannot quietly replace one. */
  takenNames: string[];
  onCancel: () => void;
  onSave: (draft: McpDraft) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<Tab>('form');
  const [name, setName] = useState('');
  const [transport, setTransport] = useState<Transport>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState('');
  const [env, setEnv] = useState('');
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState('');
  const [authKind, setAuthKind] = useState<McpAuth['kind']>('none');
  const [hasToken, setHasToken] = useState(false);
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [paste, setPaste] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Every open starts from what is being edited, or from nothing. Without this
  // the second Add of a session opens holding the first one's answers.
  useEffect(() => {
    if (!open) return;
    setTab('form');
    setError(null);
    setPaste('');
    setToken(undefined);
    if (editing === null) {
      setName('');
      setTransport('stdio');
      setCommand('');
      setArgs('');
      setEnv('');
      setUrl('');
      setHeaders('');
      setAuthKind('none');
      setHasToken(false);
      return;
    }
    const { config } = editing;
    setName(editing.name);
    setTransport(transportOf(config));
    setCommand(config.command ?? '');
    setArgs((config.args ?? []).join('\n'));
    setEnv(formatEnv(config.env));
    setUrl(config.url ?? '');
    setHeaders(formatHeaders(config.headers));
    setAuthKind(config.auth?.kind ?? 'none');
    setHasToken(editing.hasCredential);
  }, [open, editing]);

  const taken = new Set(takenNames.filter((n) => n !== editing?.name));

  const submit = (): void => {
    if (tab === 'paste') {
      const result = parsePasted(paste);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const clash = Object.keys(result.servers).find((n) => taken.has(n));
      if (clash !== undefined) {
        setError(`There is already a server called "${clash}".`);
        return;
      }
      onSave({ replacing: editing?.name ?? null, servers: result.servers });
      return;
    }

    const trimmed = name.trim();
    if (trimmed === '') {
      setError('Give the server a name.');
      return;
    }
    if (taken.has(trimmed)) {
      setError(`There is already a server called "${trimmed}".`);
      return;
    }
    if (transport === 'stdio' && command.trim() === '') {
      setError('A local server needs a command to run.');
      return;
    }
    if (transport === 'http' && url.trim() === '') {
      setError('A remote server needs a URL.');
      return;
    }

    const config: McpServerConfig =
      transport === 'stdio'
        ? {
            command: command.trim(),
            args: parseArgs(args),
            env: parseEnv(env),
            enabled: editing?.config.enabled ?? true,
            disabledTools: editing?.config.disabledTools,
            importedFrom: editing?.config.importedFrom
          }
        : {
            url: url.trim(),
            headers: parseHeaders(headers),
            auth: { kind: authKind },
            enabled: editing?.config.enabled ?? true,
            disabledTools: editing?.config.disabledTools,
            importedFrom: editing?.config.importedFrom
          };

    onSave({
      replacing: editing?.name ?? null,
      servers: { [trimmed]: config },
      // Only the bearer choice stores one. Switching away from it clears what
      // was there, so a server set back to no auth stops carrying a credential
      // nothing will send.
      token: transport === 'http' && authKind === 'bearer' ? token : null
    });
  };

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      panelClassName="w-[560px] max-h-[min(82vh,700px)] flex flex-col bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <Plug size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">
            {editing === null ? 'Add MCP server' : `Edit ${editing.name}`}
          </h2>
          <p className="text-xs text-fleet-text-muted">
            Its tools become available to every agent pane.
          </p>
        </div>
      </div>

      {editing === null && (
        <div className="px-5 pb-3">
          <div className="inline-flex gap-0.5 rounded-lg border border-fleet-border bg-fleet-surface-2 p-0.5">
            {(
              [
                { id: 'form', label: 'Form' },
                { id: 'paste', label: 'Paste JSON' }
              ] as const
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  setError(null);
                }}
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
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto border-t border-fleet-border px-5 py-4">
        {tab === 'paste' ? (
          <Field
            label="Server JSON"
            description='Either {"mcpServers": {…}} or the servers on their own. Paste it straight from the docs.'
            layout="stack"
            htmlFor="mcp-paste"
          >
            <textarea
              id="mcp-paste"
              value={paste}
              onChange={(e) => {
                setPaste(e.target.value);
                setError(null);
              }}
              spellCheck={false}
              rows={12}
              placeholder={
                '{\n  "mcpServers": {\n    "context7": {\n      "url": "https://…"\n    }\n  }\n}'
              }
              className={`${inputCls} w-full resize-y font-mono text-xs`}
            />
          </Field>
        ) : (
          <>
            <Field label="Name" layout="stack" htmlFor="mcp-name">
              <input
                id="mcp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                placeholder="context7"
                className={`${inputCls} w-full`}
              />
            </Field>

            <Field label="Kind" layout="stack">
              <div className="inline-flex gap-0.5 rounded-lg border border-fleet-border bg-fleet-surface-2 p-0.5">
                {(
                  [
                    { id: 'stdio', label: 'Local command' },
                    { id: 'http', label: 'Remote URL' }
                  ] as const
                ).map(({ id, label }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTransport(id)}
                    className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      transport === id
                        ? 'bg-fleet-surface-3 text-fleet-text shadow-sm'
                        : 'text-fleet-text-muted hover:text-fleet-text'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Field>

            {transport === 'stdio' ? (
              <>
                <Field label="Command" layout="stack" htmlFor="mcp-command">
                  <input
                    id="mcp-command"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    spellCheck={false}
                    placeholder="npx"
                    className={`${inputCls} w-full font-mono text-xs`}
                  />
                </Field>
                <Field
                  label="Arguments"
                  description="One per line, so an argument with a space in it needs no quoting."
                  layout="stack"
                  htmlFor="mcp-args"
                >
                  <textarea
                    id="mcp-args"
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                    spellCheck={false}
                    rows={3}
                    placeholder={'-y\n@modelcontextprotocol/server-filesystem'}
                    className={`${inputCls} w-full resize-y font-mono text-xs`}
                  />
                </Field>
                <Field
                  label="Environment"
                  description="KEY=value, one per line. Anything that looks like a credential is stored encrypted."
                  layout="stack"
                  htmlFor="mcp-env"
                >
                  <textarea
                    id="mcp-env"
                    value={env}
                    onChange={(e) => setEnv(e.target.value)}
                    spellCheck={false}
                    rows={3}
                    placeholder="API_KEY=…"
                    className={`${inputCls} w-full resize-y font-mono text-xs`}
                  />
                </Field>
              </>
            ) : (
              <>
                <Field label="URL" layout="stack" htmlFor="mcp-url">
                  <input
                    id="mcp-url"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    spellCheck={false}
                    placeholder="https://mcp.example.com/mcp"
                    className={`${inputCls} w-full font-mono text-xs`}
                  />
                </Field>
                <Field label="Sign-in" layout="stack" htmlFor="mcp-auth">
                  <select
                    id="mcp-auth"
                    value={authKind}
                    onChange={(e) => setAuthKind(readAuthKind(e.target.value))}
                    className={`${selectCls} w-full`}
                  >
                    <option value="none">None</option>
                    <option value="bearer">Bearer token</option>
                    <option value="oauth">Sign in with the browser (OAuth)</option>
                  </select>
                </Field>
                {authKind === 'bearer' && (
                  <Field
                    label="Token"
                    description="Stored encrypted on this device when you save, and never shown again."
                    layout="stack"
                    htmlFor="mcp-token"
                  >
                    <SecretInput
                      inputId="mcp-token"
                      present={hasToken}
                      onSave={(value) => {
                        setToken(value);
                        setHasToken(true);
                      }}
                      onClear={() => {
                        setToken(null);
                        setHasToken(false);
                      }}
                      placeholder="Paste the token"
                    />
                  </Field>
                )}
                <Field
                  label="Headers"
                  description="Name: value, one per line. For anything the server wants besides the token."
                  layout="stack"
                  htmlFor="mcp-headers"
                >
                  <textarea
                    id="mcp-headers"
                    value={headers}
                    onChange={(e) => setHeaders(e.target.value)}
                    spellCheck={false}
                    rows={2}
                    placeholder="X-Workspace: acme"
                    className={`${inputCls} w-full resize-y font-mono text-xs`}
                  />
                </Field>
              </>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-fleet-border px-5 py-3">
        <span className="min-w-0 flex-1 truncate text-xs text-red-300">{error}</span>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 focus-ring"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          className="shrink-0 rounded-md fleet-accent-bg px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 active:scale-[0.98] focus-ring-offset"
        >
          {editing === null ? 'Add server' : 'Save'}
        </button>
      </div>
    </Overlay>
  );
}

/** A `<select>` hands back a string; this is the only shape it may be. */
function readAuthKind(value: string): McpAuth['kind'] {
  return value === 'bearer' || value === 'oauth' ? value : 'none';
}
