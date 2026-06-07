// src/renderer/src/components/env-sync/EnvSyncModal.tsx
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, KeyRound, Loader2, MoreHorizontal, X } from 'lucide-react';
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

// Status text colour by state: green = settled, amber = action available, red = problem.
const STATE_TEXT: Record<TargetSyncState, string> = {
  'in-sync': 'text-emerald-400',
  'remote-ahead': 'text-amber-400',
  'local-ahead': 'text-amber-400',
  conflict: 'text-red-400',
  'local-only': 'text-amber-400',
  'remote-only': 'text-amber-400',
  'no-remote-no-local': 'text-neutral-500',
  error: 'text-red-400'
};

/** The single recommended sync action for a state, or null when nothing to do. */
function primaryAction(state: TargetSyncState): { dir: 'pull' | 'push'; label: string } | null {
  switch (state) {
    case 'remote-ahead':
    case 'remote-only':
      return { dir: 'pull', label: 'Pull' };
    case 'local-ahead':
    case 'local-only':
      return { dir: 'push', label: 'Push' };
    case 'conflict':
      return { dir: 'pull', label: 'Resolve' };
    case 'in-sync':
    case 'no-remote-no-local':
    case 'error':
      return null;
  }
}

const inputCls =
  'w-full bg-neutral-800 text-sm text-neutral-200 rounded-md px-3 py-2 border border-neutral-700 transition-colors focus:border-neutral-500 focus:outline-none';

const primaryBtn =
  'inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition active:scale-[0.97] hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 disabled:active:scale-100';

// Small neutral pill button (Save / Add selected etc.).
const neutralBtn =
  'inline-flex items-center justify-center gap-2 rounded-md bg-neutral-700 px-3 py-2 text-sm text-neutral-100 transition active:scale-[0.97] hover:bg-neutral-600 disabled:text-neutral-500 disabled:active:scale-100';

const SPIN = <Loader2 size={14} className="animate-spin" />;

function basename(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}

/** Vertical label + control. Top-aligned labels read ~50% faster than left-aligned. */
function Field({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      {children}
    </div>
  );
}

/** Collapsible section so advanced/secondary controls stay out of the way until needed. */
function Disclosure({
  title,
  summary,
  defaultOpen = false,
  children
}: {
  title: string;
  summary?: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-neutral-800">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-neutral-800/40"
      >
        <ChevronRight
          size={15}
          className={`shrink-0 text-neutral-500 transition-transform ${open ? 'rotate-90' : ''}`}
        />
        <span className="text-sm font-medium text-neutral-300">{title}</span>
        {summary && !open && (
          <span className="ml-auto truncate pl-3 text-xs text-neutral-500">{summary}</span>
        )}
      </button>
      {open && <div className="space-y-4 border-t border-neutral-800 px-4 py-4">{children}</div>}
    </div>
  );
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
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await window.fleet.envSync.setPassphrase({ id, passphrase: draft });
      setDraft('');
      await onChanged();
      showToast('Passphrase saved');
    } finally {
      setSaving(false);
    }
  };
  const clear = async (): Promise<void> => {
    setClearing(true);
    try {
      await window.fleet.envSync.clearPassphrase({ id });
      await onChanged();
    } finally {
      setClearing(false);
    }
  };

  return present ? (
    <div className="flex items-center gap-3">
      <span className="text-sm text-neutral-400">●●●●●●●● (set)</span>
      <button
        disabled={clearing}
        className="inline-flex items-center gap-1.5 text-xs text-red-400 transition-colors hover:text-red-300 disabled:text-neutral-500"
        onClick={() => void clear()}
      >
        {clearing && SPIN}
        {clearLabel}
      </button>
    </div>
  ) : (
    <div className="flex items-center gap-3">
      <input
        type="password"
        autoComplete="off"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="Encryption passphrase"
        className={inputCls}
      />
      <button
        disabled={!draft || !encAvailable || saving}
        onClick={() => void save()}
        className={`shrink-0 ${neutralBtn}`}
      >
        {saving && SPIN}
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
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

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
    setSaving(true);
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
    } finally {
      setSaving(false);
    }
  };
  const reset = async (): Promise<void> => {
    setResetting(true);
    try {
      await window.fleet.envSync.clearAuth({ id });
      await onChanged();
    } finally {
      setResetting(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
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
        <div className="flex flex-col gap-3">
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

      <div className="flex items-center gap-3">
        <button disabled={saving} onClick={() => void save()} className={neutralBtn}>
          {saving && SPIN}
          Save
        </button>
        {redacted && (
          <button
            disabled={resetting}
            className="inline-flex items-center gap-1.5 text-xs text-red-400 transition-colors hover:text-red-300 disabled:text-neutral-500"
            onClick={() => void reset()}
          >
            {resetting && SPIN}
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
      <div className="flex items-center gap-3">
        <span className="text-sm text-neutral-400">
          Inherits global ({authSummary(globalAuth)})
        </span>
        <button
          className="text-xs text-blue-400 transition-colors hover:text-blue-300"
          onClick={() => setEditing(true)}
        >
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
  const [creating, setCreating] = useState(false);

  const create = async (): Promise<void> => {
    const trimmedId = id.trim();
    const trimmedBucket = bucket.trim();
    const trimmedRegion = region.trim();
    if (!trimmedId || !trimmedBucket || !trimmedRegion) {
      showToast('Id, bucket, and region are required', { duration: 4000 });
      return;
    }
    setCreating(true);
    try {
      await onCreate({
        version: 1,
        id: trimmedId,
        bucket: trimmedBucket,
        region: trimmedRegion,
        targets: []
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="space-y-5 rounded-lg border border-neutral-800 p-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-neutral-200">Set up this repo</h3>
        <p className="text-xs text-neutral-500">
          No <code className="text-neutral-400">.fleet/env-sync.json</code> here yet. Create one to
          start syncing env files.
        </p>
        <p className="break-all pt-1 text-xs text-neutral-600">{repoDir}</p>
      </div>
      <Field label="Repo id (S3 namespace)">
        <input value={id} onChange={(e) => setId(e.target.value)} className={inputCls} />
      </Field>
      <Field label="S3 bucket">
        <input
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          placeholder="my-fleet-env-bucket"
          className={inputCls}
        />
      </Field>
      <Field label="AWS region">
        <input
          value={region}
          onChange={(e) => setRegion(e.target.value)}
          placeholder="us-east-1"
          className={inputCls}
        />
      </Field>
      <button disabled={creating} onClick={() => void create()} className={primaryBtn}>
        {creating && SPIN}
        Create config
      </button>
    </div>
  );
}

function RepoManager({
  repoDir,
  config,
  statuses,
  reload
}: {
  repoDir: string;
  config: EnvSyncConfig;
  statuses: TargetStatus[];
  reload: () => Promise<void>;
}): React.JSX.Element {
  const showToast = useToastStore((s) => s.show);

  const [editing, setEditing] = useState(false);
  const [bucketDraft, setBucketDraft] = useState(config.bucket);
  const [regionDraft, setRegionDraft] = useState(config.region);
  // null = scan panel closed; an array (possibly empty) = panel open with results.
  const [candidates, setCandidates] = useState<string[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmBucket, setConfirmBucket] = useState(false);
  const [creatingBucket, setCreatingBucket] = useState(false);
  // envFile whose row "more actions" menu is open, or null.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // In-flight async feedback.
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [savingBucket, setSavingBucket] = useState(false);

  const createBucket = async (): Promise<void> => {
    setCreatingBucket(true);
    const res = await window.fleet.envSync.createBucket(repoDir);
    setCreatingBucket(false);
    setConfirmBucket(false);
    if (res.ok) {
      showToast(`Created bucket ${config.bucket}`);
      await reload();
    } else {
      showToast(`Create bucket failed: ${res.error}`, { duration: 6000 });
    }
  };

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
    setSavingBucket(true);
    try {
      if (await saveConfig({ ...config, bucket, region })) {
        setEditing(false);
        showToast('Saved bucket/region');
      }
    } finally {
      setSavingBucket(false);
    }
  };

  const runScan = async (): Promise<void> => {
    setScanning(true);
    try {
      const found = await window.fleet.envSync.scan(repoDir);
      const existing = new Set(config.targets.map((t) => t.envFile));
      const fresh = found.filter((f) => !existing.has(f));
      setCandidates(fresh);
      setSelected(new Set(fresh));
    } finally {
      setScanning(false);
    }
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
    setAdding(true);
    try {
      if (await saveConfig({ ...config, targets: [...config.targets, ...additions] })) {
        closeScan();
        showToast(`Added ${additions.length} target${additions.length === 1 ? '' : 's'}`);
      }
    } finally {
      setAdding(false);
    }
  };

  const changeDelivery = async (envFile: string, delivery: 'file' | 'inject'): Promise<void> => {
    const targets = config.targets.map((t) => (t.envFile === envFile ? { ...t, delivery } : t));
    setMenuFor(null);
    await saveConfig({ ...config, targets });
  };

  const doSync = async (envFile: string, dir: 'pull' | 'push'): Promise<void> => {
    setMenuFor(null);
    setBusyRow(envFile);
    try {
      const res =
        dir === 'pull'
          ? await window.fleet.envSync.pull(repoDir, envFile, false)
          : await window.fleet.envSync.push(repoDir, envFile, false);
      if (res.ok) {
        showToast(`${dir === 'pull' ? 'Pulled' : 'Pushed'} ${envFile}`);
        await reload();
      } else if ('conflict' in res && res.conflict) {
        window.dispatchEvent(
          new CustomEvent('env-sync:conflict', { detail: { repoDir, envFile } })
        );
      } else {
        showToast(`Sync failed: ${'error' in res ? res.error : 'unknown'}`, { duration: 6000 });
      }
    } finally {
      setBusyRow(null);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 p-5">
      {/* Click-away catcher for the row action menu. */}
      {menuFor && <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} />}

      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-neutral-200">{config.id}</span>
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              value={bucketDraft}
              onChange={(e) => setBucketDraft(e.target.value)}
              placeholder="Bucket"
              className="w-36 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200"
            />
            <input
              value={regionDraft}
              onChange={(e) => setRegionDraft(e.target.value)}
              placeholder="Region"
              className="w-28 rounded-md border border-neutral-700 bg-neutral-800 px-3 py-1.5 text-sm text-neutral-200"
            />
            <button
              disabled={savingBucket}
              className="inline-flex items-center gap-1.5 text-xs text-blue-400 transition-colors hover:text-blue-300 disabled:text-neutral-500"
              onClick={() => void saveBucketRegion()}
            >
              {savingBucket && <Loader2 size={12} className="animate-spin" />}
              Save
            </button>
            <button
              className="text-xs text-neutral-400 transition-colors hover:text-neutral-200"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <span className="text-xs text-neutral-500">
              {config.bucket} · {config.region}
            </span>
            <button
              className="text-xs text-blue-400 transition-colors hover:text-blue-300"
              onClick={startEdit}
            >
              Edit
            </button>
            {confirmBucket ? (
              <span className="flex items-center gap-2 text-xs">
                <span className="text-neutral-400">Create in {config.region}?</span>
                <button
                  disabled={creatingBucket}
                  className="inline-flex items-center gap-1.5 text-blue-400 transition-colors hover:text-blue-300 disabled:text-neutral-500"
                  onClick={() => void createBucket()}
                >
                  {creatingBucket && <Loader2 size={12} className="animate-spin" />}
                  {creatingBucket ? 'Creating…' : 'Create'}
                </button>
                <button
                  className="text-neutral-400 transition-colors hover:text-neutral-200"
                  onClick={() => setConfirmBucket(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                className="text-xs text-blue-400 transition-colors hover:text-blue-300"
                onClick={() => setConfirmBucket(true)}
              >
                Create bucket
              </button>
            )}
          </div>
        )}
      </div>

      {statuses.length === 0 ? (
        <p className="mt-5 text-xs text-neutral-500">
          No env files tracked yet. Scan to add some below.
        </p>
      ) : (
        <table className="mt-5 w-full border-separate border-spacing-y-1 text-sm">
          <tbody>
            {statuses.map((t) => {
              const action = primaryAction(t.state);
              return (
                <Fragment key={t.envFile}>
                  <tr>
                    <td className="py-2 pr-3 text-neutral-200">{t.envFile}</td>
                    <td className={`py-2 pr-3 ${STATE_TEXT[t.state]}`} title={t.error}>
                      {STATUS_LABEL[t.state]}
                    </td>
                    <td className="py-2 text-right">
                      <div className="relative inline-flex items-center justify-end gap-2">
                        {action && (
                          <button
                            disabled={busyRow === t.envFile}
                            className="inline-flex items-center gap-1.5 rounded-md bg-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-100 transition active:scale-[0.94] hover:bg-neutral-600 disabled:active:scale-100"
                            onClick={() => void doSync(t.envFile, action.dir)}
                          >
                            {busyRow === t.envFile && (
                              <Loader2 size={12} className="animate-spin" />
                            )}
                            {action.label}
                          </button>
                        )}
                        <button
                          aria-label="More actions"
                          disabled={busyRow === t.envFile}
                          className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-neutral-200 disabled:opacity-50"
                          onClick={() => setMenuFor(menuFor === t.envFile ? null : t.envFile)}
                        >
                          <MoreHorizontal size={15} />
                        </button>
                        {menuFor === t.envFile && (
                          <div className="absolute right-0 top-full z-20 mt-1 w-44 rounded-md border border-neutral-700 bg-neutral-800 py-1.5 text-left shadow-xl">
                            <button
                              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 transition-colors hover:bg-neutral-700"
                              onClick={() => void doSync(t.envFile, 'pull')}
                            >
                              Pull from remote
                            </button>
                            <button
                              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 transition-colors hover:bg-neutral-700"
                              onClick={() => void doSync(t.envFile, 'push')}
                            >
                              Push to remote
                            </button>
                            <div className="my-1.5 border-t border-neutral-700" />
                            <div className="px-3 py-1 text-[11px] uppercase tracking-wide text-neutral-500">
                              Delivery
                            </div>
                            <button
                              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 transition-colors hover:bg-neutral-700"
                              onClick={() => void changeDelivery(t.envFile, 'file')}
                            >
                              {t.delivery === 'file' ? '✓ ' : '  '}Write file
                            </button>
                            <button
                              className="block w-full px-3 py-1.5 text-left text-xs text-neutral-200 transition-colors hover:bg-neutral-700"
                              onClick={() => void changeDelivery(t.envFile, 'inject')}
                            >
                              {t.delivery === 'inject' ? '✓ ' : '  '}Inject into env
                            </button>
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                  {t.error && (
                    <tr>
                      <td colSpan={3} className="pb-2 text-xs leading-relaxed text-red-400">
                        {t.error}
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}

      <div className="mt-5">
        {candidates === null ? (
          <button
            disabled={scanning}
            className="inline-flex items-center gap-1.5 text-xs text-blue-400 transition-colors hover:text-blue-300 disabled:text-neutral-500"
            onClick={() => void runScan()}
          >
            {scanning && <Loader2 size={12} className="animate-spin" />}
            {scanning ? 'Scanning…' : '+ Scan for env files'}
          </button>
        ) : (
          <div className="rounded-lg border border-neutral-800 p-4">
            {candidates.length === 0 ? (
              <p className="text-xs text-neutral-500">No new env files found.</p>
            ) : (
              <div className="space-y-2">
                {candidates.map((path) => (
                  <label key={path} className="flex items-center gap-3 text-sm text-neutral-300">
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
            <div className="mt-4 flex items-center gap-3">
              <button
                disabled={selected.size === 0 || adding}
                className="inline-flex items-center gap-1.5 rounded-md bg-neutral-700 px-3 py-1.5 text-xs text-neutral-100 transition active:scale-[0.96] hover:bg-neutral-600 disabled:text-neutral-500 disabled:active:scale-100"
                onClick={() => void addSelected()}
              >
                {adding && <Loader2 size={12} className="animate-spin" />}
                Add selected
              </button>
              <button
                className="text-xs text-neutral-400 transition-colors hover:text-neutral-200"
                onClick={closeScan}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
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

  const globalSummary = `${secrets.globalPresent ? 'Passphrase set' : 'No passphrase'} · ${authSummary(secrets.globalAuth)}`;

  // Effective AWS auth for the active repo: a per-repo override wins, else global.
  const repoAuthOverride = config ? secrets.authRepoOverrides[config.id] : undefined;
  const effectiveAuth = repoAuthOverride ?? secrets.globalAuth;
  const authIsOverride = Boolean(repoAuthOverride);

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
        className="flex max-h-[85vh] w-[600px] flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <h2 className="text-base font-semibold text-neutral-100">Env Sync</h2>
          <button
            onClick={onClose}
            className="rounded-md p-1.5 text-neutral-500 transition-colors hover:bg-neutral-800 hover:text-white active:scale-90"
          >
            <X size={16} />
          </button>
        </div>

        {!loading && (
          <div className="flex items-center gap-2 border-b border-neutral-800 bg-neutral-800/40 px-6 py-2.5 text-xs">
            <KeyRound size={13} className="shrink-0 text-neutral-500" />
            <span className="text-neutral-400">Active AWS credentials:</span>
            <span className="truncate font-medium text-neutral-100">
              {authSummary(effectiveAuth)}
            </span>
            <span
              className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
                authIsOverride
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-neutral-700/50 text-neutral-400'
              }`}
            >
              {authIsOverride ? 'repo override' : 'global'}
            </span>
          </div>
        )}

        <div className="space-y-5 overflow-y-auto p-6">
          {!encAvailable && (
            <div className="rounded-lg border border-red-700 bg-red-950/40 p-4 text-sm text-red-300">
              OS keychain encryption is unavailable. Passphrases and static AWS keys cannot be
              stored securely on this machine.
            </div>
          )}
          {encAvailable && encBackend === 'basic_text' && (
            <div className="rounded-lg border border-amber-700 bg-amber-950/40 p-4 text-sm text-amber-300">
              This Linux session uses the <code>basic_text</code> keychain backend — stored secrets
              are NOT meaningfully encrypted. Configure libsecret (gnome-keyring) or kwallet for
              real protection.
            </div>
          )}

          {loading ? (
            <p className="text-sm text-neutral-500">Loading…</p>
          ) : !repoDir ? (
            <p className="text-sm text-neutral-500">
              No active terminal directory — focus a pane to manage its env sync.
            </p>
          ) : (
            <>
              {/* Primary: this repo. */}
              {config ? (
                <RepoManager
                  repoDir={repoDir}
                  config={config}
                  statuses={statuses}
                  reload={reload}
                />
              ) : (
                <InitForm repoDir={repoDir} onCreate={createConfig} />
              )}

              {/* Secondary: shared account settings, collapsed with a state summary. */}
              <Disclosure title="Global account" summary={globalSummary}>
                <Field label="Encryption passphrase">
                  <PassphraseControl
                    present={secrets.globalPresent}
                    encAvailable={encAvailable}
                    clearLabel="Clear"
                    onChanged={reloadSecrets}
                  />
                </Field>
                <Field label="AWS authentication">
                  <AuthControl
                    redacted={secrets.globalAuth}
                    encAvailable={encAvailable}
                    resetLabel="Reset to default chain"
                    onChanged={reloadSecrets}
                  />
                </Field>
              </Disclosure>

              {/* Advanced: per-repo overrides, only meaningful once a config exists. */}
              {config && (
                <Disclosure title="Advanced — this repo overrides">
                  <Field label="Passphrase override">
                    <PassphraseControl
                      id={config.id}
                      present={Boolean(secrets.repoOverrides[config.id]?.present)}
                      encAvailable={encAvailable}
                      clearLabel="Use global"
                      onChanged={reloadSecrets}
                    />
                  </Field>
                  <Field label="AWS auth override">
                    <RepoAuthOverride
                      id={config.id}
                      override={secrets.authRepoOverrides[config.id]}
                      globalAuth={secrets.globalAuth}
                      encAvailable={encAvailable}
                      onChanged={reloadSecrets}
                    />
                  </Field>
                </Disclosure>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
