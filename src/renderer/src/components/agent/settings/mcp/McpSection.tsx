import { useEffect, useMemo, useState } from 'react';
import { Download, Plus, TriangleAlert } from 'lucide-react';
import type { McpServerConfig } from '../../../../../../shared/agent-mcp';
import { FieldGroup } from '../../../chat/settings/primitives';
import { newlyFound, statusOf, useAgentMcpStore } from '../../../../store/agent-mcp-store';
import { useWorkspaceStore } from '../../../../store/workspace-store';
import { McpServerRow } from './McpServerRow';
import { McpAddDialog, type McpDraft } from './McpAddDialog';
import { McpImportDialog } from './McpImportDialog';

/**
 * The MCP servers an agent may use.
 *
 * A tool count rather than a list: what a user is actually deciding here is how
 * much of the model's attention to spend on tools it may never call, and that
 * decision is made against a total, not against forty individual names.
 */

/**
 * Where the count stops being a fact and starts being a warning.
 *
 * Every model degrades as the tool list grows - the failure is not a refusal
 * but a wrong choice among near-identical names, which reads as the agent being
 * stupid rather than as the settings being wrong. Fifty is where the harnesses
 * that measured it start saying so.
 */
const CROWDED = 50;

export function McpSection(): React.JSX.Element {
  const { servers, statuses, credentials, detected, loaded, scanning, busy, signInErrors } =
    useAgentMcpStore();
  const store = useAgentMcpStore;
  const recentFolders = useWorkspaceStore((s) => s.recentFolders);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

  // The project scope of a scan needs a folder, and the settings pane is not
  // opened in one. The folder the user was last working in is the closest thing
  // to "the project" this pane can honestly name, and the import dialog shows
  // the path of every file it read so the guess is never silent.
  const cwd = recentFolders[0] ?? window.fleet.homeDir;

  useEffect(() => {
    void store.getState().load();
    // Scanned unprompted so the Import button can say there is something to
    // import. A user who has to press Import to find out whether pressing
    // Import is worth it will not press it.
    void store.getState().scan(cwd);
  }, [store, cwd]);

  const names = useMemo(() => Object.keys(servers).sort((a, b) => a.localeCompare(b)), [servers]);
  const toolCount = statuses.reduce((sum, s) => sum + s.toolCount, 0);
  const connected = statuses.filter((s) => s.state === 'connected').length;
  const waiting = newlyFound(detected);

  const editingServer = editing === null ? undefined : servers[editing];

  const save = (draft: McpDraft): void => {
    const entries = Object.entries(draft.servers);
    const [firstName, firstConfig] = entries[0];
    // A rename is one write, not a delete and an add: main forgets the
    // credentials of a server that leaves the list, and doing it in two steps
    // would take the user's token with it.
    const written =
      draft.replacing !== null && entries.length === 1 && draft.replacing !== firstName
        ? store.getState().rename(draft.replacing, firstName, firstConfig)
        : store.getState().put(firstName, firstConfig);

    void written.then(async () => {
      for (const [name, config] of entries.slice(1)) {
        await store.getState().put(name, config);
      }
      if (draft.token !== undefined) await store.getState().setToken(firstName, draft.token);
    });

    setAdding(false);
    setEditing(null);
  };

  const patch = (name: string, config: McpServerConfig, change: Partial<McpServerConfig>): void => {
    void store.getState().put(name, { ...config, ...change });
  };

  return (
    <FieldGroup title="MCP servers">
      {names.length === 0 ? (
        <div className="rounded-lg border border-dashed border-fleet-border-strong px-4 py-6 text-center">
          <p className="text-sm text-fleet-text-secondary">No servers connected.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-fleet-text-muted">
            {loaded
              ? 'MCP servers give the agent tools Fleet does not have - a docs index, a ticket tracker, a design library.'
              : 'Loading…'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {names.map((name) => {
            const config = servers[name];
            if (config === undefined) return null;
            return (
              <McpServerRow
                key={name}
                name={name}
                config={config}
                status={statusOf(statuses, name)}
                busy={busy[name] === true}
                signInError={signInErrors[name]}
                hasCredential={credentials[name]}
                onToggle={(enabled) => patch(name, config, { enabled })}
                onEdit={() => setEditing(name)}
                onRemove={() => void store.getState().remove(name)}
                onReconnect={() => void store.getState().reconnect(name)}
                onSignIn={() => void store.getState().signIn(name)}
                onSignOut={() => void store.getState().signOut(name)}
                onToolsChange={(disabledTools) => patch(name, config, { disabledTools })}
              />
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-1.5 rounded-md border border-fleet-border-strong px-2.5 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
          >
            <Plus size={13} />
            Add server
          </button>
          <button
            type="button"
            onClick={() => setImporting(true)}
            className="flex items-center gap-1.5 rounded-md border border-fleet-border-strong px-2.5 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 active:scale-[0.98] focus-ring"
          >
            <Download size={13} />
            Import
            {waiting > 0 && (
              <span className="rounded-full fleet-accent-bg px-1.5 text-[10px] font-medium text-white">
                {waiting}
              </span>
            )}
          </button>
        </div>

        {toolCount > 0 && (
          <span
            className={`flex items-center gap-1.5 text-xs ${
              toolCount > CROWDED ? 'text-amber-400' : 'text-fleet-text-muted'
            }`}
          >
            {toolCount > CROWDED && <TriangleAlert size={12} />}
            {toolCount} {toolCount === 1 ? 'tool' : 'tools'} from {connected}{' '}
            {connected === 1 ? 'server' : 'servers'}
          </span>
        )}
      </div>

      {toolCount > CROWDED && (
        <p className="text-xs text-fleet-text-muted">
          Past about {CROWDED} tools models start picking the wrong one. Switch off the tools you do
          not use, on the servers above.
        </p>
      )}

      <McpAddDialog
        open={adding || editingServer !== undefined}
        editing={
          editing !== null && editingServer !== undefined
            ? { name: editing, config: editingServer, hasCredential: credentials[editing] }
            : null
        }
        takenNames={names}
        onCancel={() => {
          setAdding(false);
          setEditing(null);
        }}
        onSave={save}
      />

      <McpImportDialog
        open={importing}
        detected={detected}
        scanning={scanning}
        onCancel={() => setImporting(false)}
        onImport={(picked) => {
          setImporting(false);
          void store.getState().importPicked(picked, cwd);
        }}
      />
    </FieldGroup>
  );
}
