// src/renderer/src/components/settings/EnvSyncSection.tsx
import { useEffect, useState, useCallback } from 'react';
import { SettingRow } from './SettingRow';
import { useToastStore } from '../../store/toast-store';
import type {
  DiscoveredRepo,
  TargetStatus,
  TargetSyncState,
  RedactedEnvSyncSecrets,
  RedactedEnvSyncAuth,
  EnvSyncAuthMode,
  EnvSyncAuthInput,
  EnvSyncConfig,
  EnvSyncTarget
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

function RepoCard({
  repo,
  statuses,
  encAvailable,
  secrets,
  onChanged,
  onSecretsChanged,
  doSync
}: {
  repo: DiscoveredRepo;
  statuses: TargetStatus[];
  encAvailable: boolean;
  secrets: RedactedEnvSyncSecrets;
  onChanged: () => Promise<void>;
  onSecretsChanged: () => Promise<void>;
  doSync: (repoDir: string, envFile: string, dir: 'pull' | 'push') => Promise<void>;
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);
  const { repoDir, config } = repo;

  const [editing, setEditing] = useState(false);
  const [bucketDraft, setBucketDraft] = useState(config.bucket);
  const [regionDraft, setRegionDraft] = useState(config.region);
  // null = scan panel closed; an array (possibly empty) = panel open with results.
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const saveConfig = async (next: EnvSyncConfig): Promise<boolean> => {
    try {
      await window.fleet.envSync.writeConfig(repoDir, next);
      await onChanged();
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

  return (
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
            <tr key={t.envFile} className="border-t border-neutral-800">
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
              <td className="py-1 text-neutral-400">{STATUS_LABEL[t.state]}</td>
              <td className="py-1 text-right">
                <button
                  className="text-xs text-blue-400 mr-2"
                  onClick={() => void doSync(repoDir, t.envFile, 'pull')}
                >
                  Pull
                </button>
                <button
                  className="text-xs text-blue-400"
                  onClick={() => void doSync(repoDir, t.envFile, 'push')}
                >
                  Push
                </button>
              </td>
            </tr>
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
            onChanged={onSecretsChanged}
          />
        </div>
        <div className="flex items-start justify-between gap-2">
          <span className="w-32 pt-1 text-xs text-neutral-500">AWS auth override</span>
          <AuthControl
            id={config.id}
            redacted={secrets.authRepoOverrides[config.id]}
            encAvailable={encAvailable}
            resetLabel="Use global default"
            onChanged={onSecretsChanged}
          />
        </div>
      </div>
    </div>
  );
}

export function EnvSyncSection(): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);
  const [encAvailable, setEncAvailable] = useState(true);
  const [encBackend, setEncBackend] = useState<string | undefined>(undefined);
  const [secrets, setSecrets] = useState<RedactedEnvSyncSecrets>({
    globalPresent: false,
    repoOverrides: {},
    authRepoOverrides: {}
  });
  const [repos, setRepos] = useState<DiscoveredRepo[]>([]);
  const [statuses, setStatuses] = useState<Record<string, TargetStatus[]>>({});

  const refreshSecrets = useCallback(async () => {
    setSecrets(await window.fleet.envSync.getSecrets());
  }, []);

  const refreshRepos = useCallback(async () => {
    const { workspaces } = await window.fleet.layout.list();
    const cwds = new Set<string>();
    for (const ws of workspaces) {
      for (const tab of ws.tabs) if (tab.cwd) cwds.add(tab.cwd);
    }
    const found = new Map<string, DiscoveredRepo>();
    for (const cwd of cwds) {
      const repo = await window.fleet.envSync.discover(cwd);
      if (repo) found.set(repo.repoDir, repo);
    }
    const list = Array.from(found.values());
    setRepos(list);
    const next: Record<string, TargetStatus[]> = {};
    for (const r of list) {
      next[r.repoDir] = await window.fleet.envSync.status(r.repoDir);
    }
    setStatuses(next);
  }, []);

  useEffect(() => {
    void window.fleet.envSync.encryptionAvailable().then((r) => {
      setEncAvailable(r.available);
      setEncBackend(r.backend);
    });
    void refreshSecrets();
    void refreshRepos();
  }, [refreshSecrets, refreshRepos]);

  const onSecretsChanged = useCallback(async (): Promise<void> => {
    await refreshSecrets();
    await refreshRepos();
  }, [refreshSecrets, refreshRepos]);

  const doSync = async (repoDir: string, envFile: string, dir: 'pull' | 'push'): Promise<void> => {
    const res =
      dir === 'pull'
        ? await window.fleet.envSync.pull(repoDir, envFile, false)
        : await window.fleet.envSync.push(repoDir, envFile, false);
    if (res.ok) {
      showToast(`${dir === 'pull' ? 'Pulled' : 'Pushed'} ${envFile}`);
      await refreshRepos();
    } else if ('conflict' in res && res.conflict) {
      window.dispatchEvent(new CustomEvent('env-sync:conflict', { detail: { repoDir, envFile } }));
    } else {
      showToast(`Sync failed: ${'error' in res ? res.error : 'unknown'}`, { duration: 6000 });
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-neutral-200">Env Sync</h2>

      {!encAvailable && (
        <div className="rounded border border-red-700 bg-red-950/40 p-3 text-sm text-red-300">
          OS keychain encryption is unavailable. Passphrases and static AWS keys cannot be stored
          securely on this machine.
        </div>
      )}

      {encAvailable && encBackend === 'basic_text' && (
        <div className="rounded border border-amber-700 bg-amber-950/40 p-3 text-sm text-amber-300">
          This Linux session uses the <code>basic_text</code> keychain backend — stored secrets are
          NOT meaningfully encrypted. Configure libsecret (gnome-keyring) or kwallet for real
          protection.
        </div>
      )}

      <SettingRow label="Global passphrase">
        <PassphraseControl
          present={secrets.globalPresent}
          encAvailable={encAvailable}
          clearLabel="Clear"
          onChanged={onSecretsChanged}
        />
      </SettingRow>

      <SettingRow label="AWS auth">
        <AuthControl
          redacted={secrets.globalAuth}
          encAvailable={encAvailable}
          resetLabel="Reset to default chain"
          onChanged={onSecretsChanged}
        />
      </SettingRow>

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-neutral-300">Projects</h3>
        {repos.length === 0 && (
          <p className="text-xs text-neutral-500">
            No projects with a <code>.fleet/env-sync.json</code> among open workspaces.
          </p>
        )}
        {repos.map((repo) => (
          <RepoCard
            key={repo.repoDir}
            repo={repo}
            statuses={statuses[repo.repoDir] ?? []}
            encAvailable={encAvailable}
            secrets={secrets}
            onChanged={refreshRepos}
            onSecretsChanged={onSecretsChanged}
            doSync={doSync}
          />
        ))}
      </div>
    </div>
  );
}
