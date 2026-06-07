// src/renderer/src/components/env-sync/EnvSyncModal.tsx
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useToastStore } from '../../store/toast-store';
import type {
  EnvSyncConfig,
  EnvSyncTarget,
  TargetStatus,
  TargetSyncState,
  RedactedEnvSyncSecrets,
  RedactedEnvSyncAuth,
  EnvSyncAuthMode,
  EnvSyncAuthInput
} from '../../../../shared/env-sync-types';

const STATUS_LABEL: Record<TargetSyncState, string> = {
  'in-sync': 'In sync',
  'remote-ahead': 'Remote ahead — pull',
  'local-ahead': 'Local ahead — push',
  conflict: 'Conflict',
  'local-only': 'Local only — push',
  'remote-only': 'Remote only — pull',
  'no-remote-no-local': 'Nothing yet',
  error: 'Error'
};

const inputCls =
  'bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700';

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

function PassphraseControl({
  id,
  present,
  encAvailable,
  clearLabel,
  onChanged
}: {
  id?: string;
  present: boolean;
  encAvailable: boolean;
  clearLabel: string;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);
  const [draft, setDraft] = useState('');

  const save = async (): Promise<void> => {
    await window.fleet.envSync.setPassphrase({ id, passphrase: draft });
    setDraft('');
    await onChanged();
    showToast('Passphrase saved');
  };
  const clear = async (): Promise<void> => {
    await window.fleet.envSync.clearPassphrase({ id });
    await onChanged();
  };

  return present ? (
    <div className="flex items-center gap-2">
      <span className="text-sm text-neutral-400">●●●●●●●● (set)</span>
      <button className="text-xs text-red-400" onClick={() => void clear()}>
        {clearLabel}
      </button>
    </div>
  ) : (
    <div className="flex items-center gap-2">
      <input
        type="password"
        autoComplete="off"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Encryption passphrase"
        className={inputCls}
      />
      <button
        disabled={!draft || !encAvailable}
        onClick={() => void save()}
        className="text-xs bg-neutral-700 rounded px-2 py-1 disabled:text-neutral-500"
      >
        Save
      </button>
    </div>
  );
}

function AuthControl({
  id,
  redacted,
  encAvailable,
  resetLabel,
  onChanged
}: {
  id?: string;
  redacted: RedactedEnvSyncAuth | undefined;
  encAvailable: boolean;
  resetLabel: string;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);
  const [mode, setMode] = useState<EnvSyncAuthMode>(redacted?.mode ?? 'default-chain');
  const [profile, setProfile] = useState(redacted?.profile ?? '');
  const [accessKeyId, setAccessKeyId] = useState('');
  const [secretAccessKey, setSecretAccessKey] = useState('');
  const [sessionToken, setSessionToken] = useState('');

  useEffect(() => {
    setMode(redacted?.mode ?? 'default-chain');
    setProfile(redacted?.profile ?? '');
  }, [redacted]);

  const save = async (): Promise<void> => {
    const auth: EnvSyncAuthInput = { mode };
    if (mode === 'profile') auth.profile = profile;
    if (mode === 'static') {
      auth.accessKeyId = accessKeyId;
      auth.secretAccessKey = secretAccessKey;
      if (sessionToken) auth.sessionToken = sessionToken;
    }
    try {
      await window.fleet.envSync.setAuth({ id, auth });
      setAccessKeyId('');
      setSecretAccessKey('');
      setSessionToken('');
      await onChanged();
      showToast('AWS auth saved');
    } catch (err) {
      showToast(`Could not save AWS auth: ${err instanceof Error ? err.message : 'unknown'}`, {
        duration: 6000
      });
    }
  };
  const reset = async (): Promise<void> => {
    await window.fleet.envSync.clearAuth({ id });
    await onChanged();
  };

  return (
    <div className="flex flex-col gap-2">
      <select
        value={mode}
        onChange={(e) => {
          const v = e.target.value;
          if (v === 'default-chain' || v === 'profile' || v === 'static') setMode(v);
        }}
        className={inputCls}
      >
        <option value="default-chain">Default credential chain</option>
        <option value="profile">Named profile</option>
        <option value="static" disabled={!encAvailable}>
          Static keys
        </option>
      </select>

      {mode === 'profile' && (
        <input
          type="text"
          value={profile}
          onChange={(e) => setProfile(e.target.value)}
          placeholder="AWS profile name (e.g. work)"
          className={inputCls}
        />
      )}

      {mode === 'static' && (
        <div className="flex flex-col gap-2">
          {redacted?.mode === 'static' && redacted.hasAccessKeyId ? (
            <span className="text-sm text-neutral-400">
              Static keys ●●●● (set) — re-enter below to replace
            </span>
          ) : null}
          <input
            type="text"
            autoComplete="off"
            value={accessKeyId}
            onChange={(e) => setAccessKeyId(e.target.value)}
            placeholder="Access key ID"
            className={inputCls}
          />
          <input
            type="password"
            autoComplete="off"
            value={secretAccessKey}
            onChange={(e) => setSecretAccessKey(e.target.value)}
            placeholder="Secret access key"
            className={inputCls}
          />
          <input
            type="password"
            autoComplete="off"
            value={sessionToken}
            onChange={(e) => setSessionToken(e.target.value)}
            placeholder="Session token (optional)"
            className={inputCls}
          />
        </div>
      )}

      <div className="flex items-center gap-2">
        <button onClick={() => void save()} className="text-xs bg-neutral-700 rounded px-2 py-1">
          Save
        </button>
        {redacted && (
          <button className="text-xs text-red-400" onClick={() => void reset()}>
            {resetLabel}
          </button>
        )}
      </div>
    </div>
  );
}

function authSummary(a: RedactedEnvSyncAuth | undefined): string {
  if (!a || a.mode === 'default-chain') return 'Default credential chain';
  if (a.mode === 'profile') return `Profile: ${a.profile || '(unset)'}`;
  return 'Static keys';
}

/**
 * Per-repo AWS auth override. When no override is stored the repo inherits the
 * global auth, so show that explicitly (with an Override button) instead of a
 * populated default-chain dropdown that looks like an active default-chain choice.
 */
function RepoAuthOverride({
  id,
  override,
  globalAuth,
  encAvailable,
  onChanged
}: {
  id: string;
  override: RedactedEnvSyncAuth | undefined;
  globalAuth: RedactedEnvSyncAuth | undefined;
  encAvailable: boolean;
  onChanged: () => Promise<void>;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);

  if (!override && !editing) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-neutral-400">Inherits global ({authSummary(globalAuth)})</span>
        <button className="text-xs text-blue-400" onClick={() => setEditing(true)}>
          Override
        </button>
      </div>
    );
  }

  return (
    <AuthControl
      id={id}
      redacted={override}
      encAvailable={encAvailable}
      resetLabel="Use global default"
      onChanged={async () => {
        setEditing(false);
        await onChanged();
      }}
    />
  );
}

function InitForm({
  repoDir,
  onCreate
}: {
  repoDir: string;
  onCreate: (config: EnvSyncConfig) => Promise<void>;
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);
  const [id, setId] = useState(basename(repoDir));
  const [bucket, setBucket] = useState('');
  const [region, setRegion] = useState('');

  const create = async (): Promise<void> => {
    const trimmedId = id.trim();
    const trimmedBucket = bucket.trim();
    const trimmedRegion = region.trim();
    if (!trimmedId || !trimmedBucket || !trimmedRegion) {
      showToast('Id, bucket, and region are required', { duration: 4000 });
      return;
    }
    await onCreate({
      version: 1,
      id: trimmedId,
      bucket: trimmedBucket,
      region: trimmedRegion,
      targets: []
    });
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-neutral-400">
        No <code>.fleet/env-sync.json</code> here yet. Create one to start syncing env files.
      </p>
      <p className="break-all text-xs text-neutral-500">{repoDir}</p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-400">Repo id (S3 namespace)</span>
        <input value={id} onChange={(e) => setId(e.target.value)} className={inputCls} />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-400">S3 bucket</span>
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="my-fleet-env-bucket"
          className={inputCls}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-400">AWS region</span>
        <input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="us-east-1"
          className={inputCls}
        />
      </label>
      <button
        onClick={() => void create()}
        className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-500"
      >
        Create config
      </button>
    </div>
  );
}

function RepoManager({
  repoDir,
  config,
  statuses,
  encAvailable,
  secrets,
  reload,
  reloadSecrets
}: {
  repoDir: string;
  config: EnvSyncConfig;
  statuses: TargetStatus[];
  encAvailable: boolean;
  secrets: RedactedEnvSyncSecrets;
  reload: () => Promise<void>;
  reloadSecrets: () => Promise<void>;
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);

  const [editing, setEditing] = useState(false);
  const [bucketDraft, setBucketDraft] = useState(config.bucket);
  const [regionDraft, setRegionDraft] = useState(config.region);
  // null = scan panel closed; an array (possibly empty) = panel open with results.
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const saveConfig = async (next: EnvSyncConfig): Promise<boolean> => {
    try {
      await window.fleet.envSync.writeConfig(repoDir, next);
      await reload();
      return true;
    } catch (err) {
      showToast(`Could not save config: ${err instanceof Error ? err.message : 'unknown'}`, {
        duration: 6000
      });
      return false;
    }
  };

  const startEdit = (): void => {
    setBucketDraft(config.bucket);
    setRegionDraft(config.region);
    setEditing(true);
  };

  const saveBucketRegion = async (): Promise<void> => {
    const bucket = bucketDraft.trim();
    const region = regionDraft.trim();
    if (!bucket || !region) {
      showToast('Bucket and region are required', { duration: 4000 });
      return;
    }
    if (await saveConfig({ ...config, bucket, region })) {
      setEditing(false);
      showToast('Saved bucket/region');
    }
  };

  const runScan = async (): Promise<void> => {
    const found = await window.fleet.envSync.scan(repoDir);
    const existing = new Set(config.targets.map((t) => t.envFile));
    const fresh = found.filter((f) => !existing.has(f));
    setCandidates(fresh);
    setSelected(new Set(fresh));
  };

  const toggleCandidate = (path: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const closeScan = (): void => {
    setCandidates(null);
    setSelected(new Set());
  };

  const addSelected = async (): Promise<void> => {
    const additions: EnvSyncTarget[] = Array.from(selected).map((envFile) => ({
      envFile,
      delivery: 'file'
    }));
    if (additions.length === 0) return;
    if (await saveConfig({ ...config, targets: [...config.targets, ...additions] })) {
      closeScan();
      showToast(`Added ${additions.length} target${additions.length === 1 ? '' : 's'}`);
    }
  };

  const changeDelivery = async (envFile: string, delivery: 'file' | 'inject'): Promise<void> => {
    const targets = config.targets.map((t) => (t.envFile === envFile ? { ...t, delivery } : t));
    await saveConfig({ ...config, targets });
  };

  const doSync = async (envFile: string, dir: 'pull' | 'push'): Promise<void> => {
    const res =
      dir === 'pull'
        ? await window.fleet.envSync.pull(repoDir, envFile, false)
        : await window.fleet.envSync.push(repoDir, envFile, false);
    if (res.ok) {
      showToast(`${dir === 'pull' ? 'Pulled' : 'Pushed'} ${envFile}`);
      await reload();
    } else if ('conflict' in res && res.conflict) {
      window.dispatchEvent(new CustomEvent('env-sync:conflict', { detail: { repoDir, envFile } }));
    } else {
      showToast(`Sync failed: ${'error' in res ? res.error : 'unknown'}`, { duration: 6000 });
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded border border-neutral-800 p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-neutral-200">{config.id}</span>
          {editing ? (
            <div className="flex items-center gap-2">
              <input
                value={bucketDraft}
                onChange={(e) => setBucketDraft(e.target.value)}
                placeholder="Bucket"
                className={`${inputCls} w-36`}
              />
              <input
                value={regionDraft}
                onChange={(e) => setRegionDraft(e.target.value)}
                placeholder="Region"
                className={`${inputCls} w-28`}
              />
              <button className="text-xs text-blue-400" onClick={() => void saveBucketRegion()}>
                Save
              </button>
              <button className="text-xs text-neutral-400" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <span className="text-xs text-neutral-500">
                {config.bucket} · {config.region}
              </span>
              <button className="text-xs text-blue-400" onClick={startEdit}>
                Edit
              </button>
            </div>
          )}
        </div>

        <table className="mt-2 w-full text-xs">
          <tbody>
            {statuses.map((t) => (
              <Fragment key={t.envFile}>
                <tr className="border-t border-neutral-800">
                  <td className="py-1 text-neutral-300">{t.envFile}</td>
                  <td className="py-1">
                    <select
                      value={t.delivery}
                      onChange={(e) => {
                        const v = e.target.value;
                        if (v === 'file' || v === 'inject') void changeDelivery(t.envFile, v);
                      }}
                      className="rounded border border-neutral-700 bg-neutral-800 px-1 py-0.5 text-neutral-400"
                    >
                      <option value="file">file</option>
                      <option value="inject">inject</option>
                    </select>
                  </td>
                  <td
                    className={`py-1 ${t.state === 'error' ? 'text-red-400' : 'text-neutral-400'}`}
                    title={t.error}
                  >
                    {STATUS_LABEL[t.state]}
                  </td>
                  <td className="py-1 text-right">
                    <button
                      className="text-xs text-blue-400 mr-2"
                      onClick={() => void doSync(t.envFile, 'pull')}
                    >
                      Pull
                    </button>
                    <button
                      className="text-xs text-blue-400"
                      onClick={() => void doSync(t.envFile, 'push')}
                    >
                      Push
                    </button>
                  </td>
                </tr>
                {t.error && (
                  <tr>
                    <td colSpan={4} className="pb-2 text-[11px] leading-snug text-red-400">
                      {t.error}
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>

        <div className="mt-2">
          {candidates === null ? (
            <button className="text-xs text-blue-400" onClick={() => void runScan()}>
              Scan for env files
            </button>
          ) : (
            <div className="rounded border border-neutral-800 p-2">
              {candidates.length === 0 ? (
                <p className="text-xs text-neutral-500">No new env files found.</p>
              ) : (
                <div className="space-y-1">
                  {candidates.map((path) => (
                    <label key={path} className="flex items-center gap-2 text-xs text-neutral-300">
                      <input
                        type="checkbox"
                        checked={selected.has(path)}
                        onChange={() => toggleCandidate(path)}
                      />
                      {path}
                    </label>
                  ))}
                </div>
              )}
              <div className="mt-2 flex items-center gap-2">
                <button
                  disabled={selected.size === 0}
                  className="text-xs bg-neutral-700 rounded px-2 py-1 disabled:text-neutral-500"
                  onClick={() => void addSelected()}
                >
                  Add selected
                </button>
                <button className="text-xs text-neutral-400" onClick={closeScan}>
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-2">
          <div className="flex items-center justify-between gap-2">
            <span className="w-32 text-xs text-neutral-500">Passphrase override</span>
            <PassphraseControl
              id={config.id}
              present={Boolean(secrets.repoOverrides[config.id]?.present)}
              encAvailable={encAvailable}
              clearLabel="Use global"
              onChanged={reloadSecrets}
            />
          </div>
          <div className="flex items-start justify-between gap-2">
            <span className="w-32 pt-1 text-xs text-neutral-500">AWS auth override</span>
            <RepoAuthOverride
              id={config.id}
              override={secrets.authRepoOverrides[config.id]}
              globalAuth={secrets.globalAuth}
              encAvailable={encAvailable}
              onChanged={reloadSecrets}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function EnvSyncModal({
  isOpen,
  onClose,
  cwd
}: {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | undefined;
}): React.JSX.Element | null {
  const showToast = useToastStore((s) => s.show);
  const panelRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [repoDir, setRepoDir] = useState<string | null>(null);
  const [config, setConfig] = useState<EnvSyncConfig | null>(null);
  const [statuses, setStatuses] = useState<TargetStatus[]>([]);
  const [encAvailable, setEncAvailable] = useState(true);
  const [encBackend, setEncBackend] = useState<string | undefined>(undefined);
  const [secrets, setSecrets] = useState<RedactedEnvSyncSecrets>({
    globalPresent: false,
    repoOverrides: {},
    authRepoOverrides: {}
  });

  const reloadSecrets = useCallback(async (): Promise<void> => {
    setSecrets(await window.fleet.envSync.getSecrets());
  }, []);

  // Reload the config + statuses for the already-resolved repoDir.
  const reload = useCallback(async (): Promise<void> => {
    if (!repoDir) return;
    const cfg = await window.fleet.envSync.getConfig(repoDir);
    setConfig(cfg);
    setStatuses(cfg ? await window.fleet.envSync.status(repoDir) : []);
  }, [repoDir]);

  // On open, resolve which repo dir this pane maps to and load its state.
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    setLoading(true);
    void (async () => {
      void window.fleet.envSync.encryptionAvailable().then((r) => {
        if (!active) return;
        setEncAvailable(r.available);
        setEncBackend(r.backend);
      });
      await reloadSecrets();
      if (!active) return;

      if (!cwd) {
        if (active) {
          setRepoDir(null);
          setConfig(null);
          setStatuses([]);
          setLoading(false);
        }
        return;
      }

      const discovered = await window.fleet.envSync.discover(cwd);
      if (discovered) {
        const status = await window.fleet.envSync.status(discovered.repoDir);
        if (!active) return;
        setRepoDir(discovered.repoDir);
        setConfig(discovered.config);
        setStatuses(status);
      } else {
        const { root } = await window.fleet.git.repoRoot(cwd);
        if (!active) return;
        setRepoDir(root ?? cwd);
        setConfig(null);
        setStatuses([]);
      }
      if (active) setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, [isOpen, cwd, reloadSecrets]);

  // Focus the panel on open so the onKeyDown Escape handler receives keys.
  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  const createConfig = async (next: EnvSyncConfig): Promise<void> => {
    if (!repoDir) return;
    try {
      await window.fleet.envSync.writeConfig(repoDir, next);
      await reload();
      showToast('Created .fleet/env-sync.json');
    } catch (err) {
      showToast(`Could not create config: ${err instanceof Error ? err.message : 'unknown'}`, {
        duration: 6000
      });
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-lg border border-neutral-700 bg-neutral-900 shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-4 py-3">
          <h2 className="text-base font-semibold text-neutral-200">Env Sync</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-white"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-4">
          {!encAvailable && (
            <div className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-300">
              OS keychain encryption is unavailable. Passphrases and static AWS keys cannot be
              stored securely on this machine.
            </div>
          )}
          {encAvailable && encBackend === 'basic_text' && (
            <div className="rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-300">
              This Linux session uses the <code>basic_text</code> keychain backend — stored secrets
              are NOT meaningfully encrypted. Configure libsecret (gnome-keyring) or kwallet for
              real protection.
            </div>
          )}

          {loading ? (
            <p className="text-xs text-neutral-500">Loading…</p>
          ) : (
            <>
              {/* Global settings are shared across every repo — always shown so the
                  current passphrase/auth state is visible while initializing or managing. */}
              <div className="space-y-2 border-b border-neutral-800 pb-3">
                <h3 className="text-xs font-medium uppercase tracking-wide text-neutral-500">
                  Global settings
                </h3>
                <div className="flex items-center justify-between gap-2">
                  <span className="w-32 text-xs text-neutral-500">Passphrase</span>
                  <PassphraseControl
                    present={secrets.globalPresent}
                    encAvailable={encAvailable}
                    clearLabel="Clear"
                    onChanged={reloadSecrets}
                  />
                </div>
                <div className="flex items-start justify-between gap-2">
                  <span className="w-32 pt-1 text-xs text-neutral-500">AWS auth</span>
                  <AuthControl
                    redacted={secrets.globalAuth}
                    encAvailable={encAvailable}
                    resetLabel="Reset to default chain"
                    onChanged={reloadSecrets}
                  />
                </div>
              </div>

              {!repoDir ? (
                <p className="text-xs text-neutral-500">
                  No active terminal directory — focus a pane to manage its env sync.
                </p>
              ) : config ? (
                <RepoManager
                  repoDir={repoDir}
                  config={config}
                  statuses={statuses}
                  encAvailable={encAvailable}
                  secrets={secrets}
                  reload={reload}
                  reloadSecrets={reloadSecrets}
                />
              ) : (
                <InitForm repoDir={repoDir} onCreate={createConfig} />
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
