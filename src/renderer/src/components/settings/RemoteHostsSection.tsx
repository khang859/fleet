import { useCallback, useMemo, useState } from 'react';
import { Check, FolderOpen, Loader2, Plus, Server, Trash2, X } from 'lucide-react';
import type { RemoteHost } from '../../../../shared/remote-ssh-types';
import { useSettingsStore } from '../../store/settings-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { useToastStore } from '../../store/toast-store';

type TestState = 'idle' | 'testing' | 'ok' | 'failed';

const inputClass =
  'w-full px-2 py-1 bg-neutral-800 border border-neutral-700 rounded text-sm text-white placeholder:text-neutral-600 focus:outline-none focus:border-neutral-500';

function emptyHost(): RemoteHost {
  return { id: crypto.randomUUID(), label: '', host: '' };
}

export function RemoteHostsSection(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const openSshBrowser = useWorkspaceStore((s) => s.openSshBrowser);
  const showToast = useToastStore((s) => s.show);

  // Memoised so the `[]` fallback doesn't produce a fresh array each render and
  // invalidate every callback that closes over the host list.
  const hosts = useMemo(() => settings?.remoteSsh.hosts ?? [], [settings]);
  const [draft, setDraft] = useState<RemoteHost | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  const persist = useCallback(
    async (next: RemoteHost[]) => {
      await updateSettings({ remoteSsh: { hosts: next } });
    },
    [updateSettings]
  );

  const saveDraft = useCallback(async () => {
    if (!draft) return;
    const label = draft.label.trim() || draft.host.trim();
    const host = draft.host.trim();
    if (!host) return;
    const cleaned: RemoteHost = { ...draft, label, host };
    const existing = hosts.some((h) => h.id === cleaned.id);
    await persist(
      existing ? hosts.map((h) => (h.id === cleaned.id ? cleaned : h)) : [...hosts, cleaned]
    );
    setDraft(null);
  }, [draft, hosts, persist]);

  const testHost = useCallback(
    async (host: RemoteHost) => {
      setTests((t) => ({ ...t, [host.id]: 'testing' }));
      const result = await window.fleet.remoteSsh.test(host);
      const ok = result.success && result.data.ok;
      setTests((t) => ({ ...t, [host.id]: ok ? 'ok' : 'failed' }));
      if (!ok) {
        const message = result.success ? result.data.error : result.error;
        showToast(message ?? `Could not connect to ${host.label}`);
      }
    },
    [showToast]
  );

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-white mb-1">Remote Hosts</h2>
        <p className="text-sm text-neutral-400">
          SSH targets you can browse as a file pane. Fleet stores only the connection coordinates -
          authentication uses your existing OpenSSH setup (<code>~/.ssh/config</code>, agent keys),
          and no passwords or key material are ever saved here.
        </p>
      </div>

      <div className="space-y-2">
        {hosts.length === 0 && draft === null && (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-neutral-500 border border-dashed border-neutral-800 rounded-md">
            <Server size={22} className="text-neutral-700" />
            No hosts saved yet
          </div>
        )}

        {hosts.map((host) =>
          draft?.id === host.id ? (
            <HostForm
              key={host.id}
              draft={draft}
              onChange={setDraft}
              onSave={() => void saveDraft()}
              onCancel={() => setDraft(null)}
            />
          ) : (
            <div
              key={host.id}
              className="flex items-center gap-3 px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-md"
            >
              <Server size={14} className="text-neutral-500 shrink-0" />
              <button
                className="flex-1 min-w-0 text-left"
                onClick={() => setDraft(host)}
                title="Edit host"
              >
                <div className="text-sm text-neutral-200 truncate">{host.label}</div>
                <div className="text-xs text-neutral-500 font-mono truncate">
                  {host.user ? `${host.user}@` : ''}
                  {host.host}
                  {host.port ? `:${host.port}` : ''}
                  {host.defaultPath ? `  ${host.defaultPath}` : ''}
                </div>
              </button>
              <TestBadge state={tests[host.id] ?? 'idle'} onTest={() => void testHost(host)} />
              <button
                className="p-1.5 rounded text-neutral-400 hover:text-white hover:bg-white/10 transition-colors active:scale-[0.97]"
                title="Browse files"
                aria-label={`Browse ${host.label}`}
                onClick={() => openSshBrowser(host)}
              >
                <FolderOpen size={14} />
              </button>
              <button
                className="p-1.5 rounded text-neutral-400 hover:text-red-400 hover:bg-white/10 transition-colors active:scale-[0.97]"
                title="Remove host"
                aria-label={`Remove ${host.label}`}
                onClick={() => void persist(hosts.filter((h) => h.id !== host.id))}
              >
                <Trash2 size={14} />
              </button>
            </div>
          )
        )}

        {draft !== null && !hosts.some((h) => h.id === draft.id) && (
          <HostForm
            draft={draft}
            onChange={setDraft}
            onSave={() => void saveDraft()}
            onCancel={() => setDraft(null)}
          />
        )}

        {draft === null && (
          <button
            className="flex items-center gap-1.5 px-2 py-1.5 text-sm text-neutral-400 hover:text-white rounded hover:bg-neutral-800/60 transition-colors active:scale-[0.97]"
            onClick={() => setDraft(emptyHost())}
          >
            <Plus size={14} />
            Add host
          </button>
        )}
      </div>
    </div>
  );
}

function TestBadge({ state, onTest }: { state: TestState; onTest: () => void }): React.JSX.Element {
  if (state === 'testing') {
    return (
      <span className="flex items-center gap-1 text-xs text-neutral-500 px-1.5">
        <Loader2 size={12} className="animate-spin" />
        Testing
      </span>
    );
  }
  return (
    <button
      className={`text-xs px-1.5 py-0.5 rounded hover:bg-white/10 transition-colors active:scale-[0.97] ${
        state === 'ok'
          ? 'text-emerald-400'
          : state === 'failed'
            ? 'text-red-400'
            : 'text-neutral-500'
      }`}
      onClick={onTest}
      title="Test connection"
    >
      {state === 'ok' ? 'Reachable' : state === 'failed' ? 'Unreachable' : 'Test'}
    </button>
  );
}

function HostForm({
  draft,
  onChange,
  onSave,
  onCancel
}: {
  draft: RemoteHost;
  onChange: (host: RemoteHost) => void;
  onSave: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  return (
    <div className="p-3 bg-neutral-900 border border-neutral-700 rounded-md space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <Field label="Name">
          <input
            autoFocus
            className={inputClass}
            placeholder="khang-linux"
            value={draft.label}
            onChange={(e) => onChange({ ...draft, label: e.target.value })}
          />
        </Field>
        <Field label="Hostname or SSH alias">
          <input
            className={inputClass}
            placeholder="khang-linux.example.ts.net"
            value={draft.host}
            onChange={(e) => onChange({ ...draft, host: e.target.value })}
          />
        </Field>
        <Field label="User">
          <input
            className={inputClass}
            placeholder="(from ~/.ssh/config)"
            value={draft.user ?? ''}
            onChange={(e) => onChange({ ...draft, user: e.target.value || undefined })}
          />
        </Field>
        <Field label="Port">
          <input
            className={inputClass}
            placeholder="22"
            inputMode="numeric"
            value={draft.port?.toString() ?? ''}
            onChange={(e) =>
              onChange({ ...draft, port: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </Field>
        <Field label="Identity file">
          <input
            className={inputClass}
            placeholder="~/.ssh/id_ed25519"
            value={draft.identityFile ?? ''}
            onChange={(e) => onChange({ ...draft, identityFile: e.target.value || undefined })}
          />
        </Field>
        <Field label="Start folder">
          <input
            className={inputClass}
            placeholder="(login home)"
            value={draft.defaultPath ?? ''}
            onChange={(e) => onChange({ ...draft, defaultPath: e.target.value || undefined })}
          />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-1.5 pt-1">
        <button
          className="flex items-center gap-1 px-2 py-1 text-xs text-neutral-400 hover:text-white rounded hover:bg-white/10 transition-colors active:scale-[0.97]"
          onClick={onCancel}
        >
          <X size={12} />
          Cancel
        </button>
        <button
          className="flex items-center gap-1 px-2 py-1 text-xs text-neutral-200 rounded bg-neutral-700 hover:bg-neutral-600 transition-colors active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none"
          disabled={draft.host.trim() === ''}
          onClick={onSave}
        >
          <Check size={12} />
          Save
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-neutral-500">{label}</span>
      {children}
    </label>
  );
}
