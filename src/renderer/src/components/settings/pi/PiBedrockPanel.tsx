import { useEffect, useState } from 'react';
import type {
  BedrockWritePatch,
  PiBedrockCredentialMode,
  RedactedBedrock
} from '../../../../../shared/pi-env-injection-types';

type Props = {
  legacyCustomProviderPresent: boolean;
  onLegacyMigrate: () => void | Promise<void>;
  onLegacyKeepAsCustom: () => void;
};

type Loaded = {
  kind: 'loaded';
  mode: PiBedrockCredentialMode;
  region: string;
  profile: string;
  accessKeyId: string;
  secretAccessKeyPresent: boolean;
  sessionTokenPresent: boolean;
  encryptionAvailable: boolean;
};

type State = { kind: 'loading' } | Loaded | { kind: 'error'; message: string };

export function PiBedrockPanel({
  legacyCustomProviderPresent,
  onLegacyMigrate,
  onLegacyKeepAsCustom
}: Props): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [secretDraft, setSecretDraft] = useState('');
  const [sessionDraft, setSessionDraft] = useState('');
  const [legacyBannerDismissed, setLegacyBannerDismissed] = useState(false);

  const load = async (): Promise<void> => {
    try {
      const [redacted, encryptionAvailable] = await Promise.all([
        window.fleet.piEnv.readBedrock(),
        window.fleet.piEnv.isEncryptionAvailable()
      ]);
      const r: RedactedBedrock = redacted ?? {
        mode: 'chain',
        secretAccessKeyPresent: false,
        sessionTokenPresent: false
      };
      setState({
        kind: 'loaded',
        mode: r.mode,
        region: r.region ?? '',
        profile: r.profile ?? '',
        accessKeyId: r.accessKeyId ?? '',
        secretAccessKeyPresent: r.secretAccessKeyPresent,
        sessionTokenPresent: r.sessionTokenPresent,
        encryptionAvailable
      });
    } catch (err) {
      setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  useEffect(() => {
    void load();
  }, []);

  if (state.kind === 'loading') {
    return <div className="text-xs text-neutral-500 px-3 py-2">Loading Bedrock settings…</div>;
  }
  if (state.kind === 'error') {
    return (
      <div className="text-xs text-red-400 px-3 py-2">
        Failed to load Bedrock settings: {state.message}
      </div>
    );
  }

  const writePatch = async (patch: BedrockWritePatch): Promise<void> => {
    await window.fleet.piEnv.writeBedrock(patch);
    await load();
  };

  const writeSecret = async (
    field: 'secretAccessKey' | 'sessionToken',
    value: string
  ): Promise<void> => {
    await writePatch({ [field]: value });
    if (field === 'secretAccessKey') setSecretDraft('');
    else setSessionDraft('');
  };

  const clearSecret = async (field: 'secretAccessKey' | 'sessionToken'): Promise<void> => {
    await window.fleet.piEnv.clearSecret(field);
    await load();
  };

  const showKeysFields = state.mode === 'keys';
  const showProfileField = state.mode === 'profile';

  return (
    <div className="space-y-3 px-3 py-3">
      {legacyCustomProviderPresent && !legacyBannerDismissed && (
        <div className="rounded border border-amber-800/50 bg-amber-950/20 px-3 py-2 text-xs text-amber-200 space-y-2">
          <p>
            We detected an existing <code>bedrock</code> entry under custom providers. Move its
            custom model ids into this panel?
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void onLegacyMigrate()}
              className="rounded bg-amber-700 px-2 py-1 text-white hover:bg-amber-600"
            >
              Move
            </button>
            <button
              type="button"
              onClick={() => {
                setLegacyBannerDismissed(true);
                onLegacyKeepAsCustom();
              }}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              Keep as custom
            </button>
          </div>
        </div>
      )}

      <div>
        <label className="text-xs text-neutral-400 block mb-1">AWS Region</label>
        <input
          type="text"
          value={state.region}
          onChange={(e) => setState({ ...state, region: e.target.value })}
          onBlur={() => void writePatch({ region: state.region })}
          placeholder="us-east-1"
          className="w-64 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
        />
        <p className="text-xs text-neutral-600 mt-1">
          Overrides any value in your shell for Fleet-launched Pi tabs.
        </p>
      </div>

      <fieldset>
        <legend className="text-xs text-neutral-400 mb-1">Credentials</legend>
        <div className="space-y-1 text-sm text-neutral-200">
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="bedrock-mode"
              checked={state.mode === 'profile'}
              onChange={() => void writePatch({ mode: 'profile' })}
            />
            Use AWS profile (recommended)
          </label>
          <label
            className={`flex items-center gap-2 ${state.encryptionAvailable ? '' : 'opacity-50'}`}
          >
            <input
              type="radio"
              name="bedrock-mode"
              disabled={!state.encryptionAvailable}
              checked={state.mode === 'keys'}
              onChange={() => void writePatch({ mode: 'keys' })}
            />
            Use access keys
            {!state.encryptionAvailable && (
              <span className="text-xs text-neutral-500">(OS keychain unavailable)</span>
            )}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="radio"
              name="bedrock-mode"
              checked={state.mode === 'chain'}
              onChange={() => void writePatch({ mode: 'chain' })}
            />
            Use credential chain (inherit from shell)
          </label>
        </div>
      </fieldset>

      {showProfileField && (
        <div>
          <label className="text-xs text-neutral-400 block mb-1">AWS Profile</label>
          <input
            type="text"
            value={state.profile}
            onChange={(e) => setState({ ...state, profile: e.target.value })}
            onBlur={() => void writePatch({ profile: state.profile })}
            placeholder="default"
            className="w-64 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
          />
        </div>
      )}

      {showKeysFields && (
        <div className="space-y-3">
          <div>
            <label className="text-xs text-neutral-400 block mb-1">Access Key ID</label>
            <input
              type="text"
              value={state.accessKeyId}
              onChange={(e) => setState({ ...state, accessKeyId: e.target.value })}
              onBlur={() => void writePatch({ accessKeyId: state.accessKeyId })}
              className="w-80 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
            />
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">
              Secret Access Key <span className="text-neutral-600">🔒 stored in OS keychain</span>
            </label>
            {state.secretAccessKeyPresent ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-300">●●●●●●●● (set)</span>
                <button
                  type="button"
                  onClick={() => void clearSecret('secretAccessKey')}
                  className="text-xs rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setState({ ...state, secretAccessKeyPresent: false });
                  }}
                  className="text-xs rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                >
                  Replace
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={secretDraft}
                  onChange={(e) => setSecretDraft(e.target.value)}
                  className="w-80 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
                />
                <button
                  type="button"
                  disabled={!secretDraft}
                  onClick={() => void writeSecret('secretAccessKey', secretDraft)}
                  className="text-xs rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500"
                >
                  Save
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-neutral-400 block mb-1">
              Session Token <span className="text-neutral-600">optional · STS · 🔒 encrypted</span>
            </label>
            {state.sessionTokenPresent ? (
              <div className="flex items-center gap-2">
                <span className="text-sm text-neutral-300">●●●●●●●● (set)</span>
                <button
                  type="button"
                  onClick={() => void clearSecret('sessionToken')}
                  className="text-xs rounded border border-neutral-700 px-2 py-0.5 hover:bg-neutral-800"
                >
                  Clear
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={sessionDraft}
                  onChange={(e) => setSessionDraft(e.target.value)}
                  className="w-80 bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700"
                />
                <button
                  type="button"
                  disabled={!sessionDraft}
                  onClick={() => void writeSecret('sessionToken', sessionDraft)}
                  className="text-xs rounded bg-blue-600 px-2 py-0.5 text-white hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500"
                >
                  Save
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      <p className="text-xs text-neutral-500">
        These values are injected into Pi tabs Fleet opens. They do not affect the <code>pi</code>{' '}
        CLI you run in a terminal.
      </p>
    </div>
  );
}
