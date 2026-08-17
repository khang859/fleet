import { useEffect, useState } from 'react';
import { CheckCircle2, HardDrive, Loader2, TriangleAlert } from 'lucide-react';
import type { LocalEndpointConfig } from '../../../../../../shared/agent-endpoints';
import { hostPort, normalizeEndpointUrl } from '../../../../../../shared/agent-endpoint-url';
import { Overlay } from '../../../Overlay';
import { inputCls } from '../controls';
import { Field } from '../primitives';
import { useAgentEndpointsStore } from '../../../../store/agent-endpoints-store';
import { newEndpointId, testOutcome, type TestOutcome } from './endpoint-copy';

/**
 * Adding a server, or editing one that is already there.
 *
 * Two fields and a button, and the button is the interesting part. What a
 * person is uncertain about here is not the form - it is whether the address
 * they typed is the one their server is on - so Test answers exactly that,
 * before anything is saved, and names what it found.
 *
 * What Test never does is stop them. Baymard's distinction between validations
 * and warnings is the whole design of this dialog: a server being off right now
 * is the ordinary state of a process on somebody's own laptop, so it is a
 * warning that still saves. The one thing that blocks is an address that cannot
 * be read as an address at all, because there is nothing to save in that case.
 */

export function EndpointDialog({
  open,
  editing,
  takenUrls,
  onCancel,
  onSave
}: {
  open: boolean;
  /** The endpoint being edited, or null when this is a new one. */
  editing: LocalEndpointConfig | null;
  /** Addresses already configured, so two rows cannot name one server. */
  takenUrls: string[];
  onCancel: () => void;
  onSave: (endpoint: LocalEndpointConfig) => void;
}): React.JSX.Element {
  const test = useAgentEndpointsStore((s) => s.test);
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);

  // Every open starts from what is being edited, or from nothing. Without this
  // the second Add of a session opens holding the first one's answers.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setOutcome(null);
    setTesting(false);
    setUrl(editing?.baseUrl ?? '');
    setName(editing?.name ?? '');
  }, [open, editing]);

  const runTest = (): void => {
    const normalized = normalizeEndpointUrl(url);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    // The address is put in its canonical form as soon as it has been read, so
    // what is tested is visibly the same string that will be saved.
    setUrl(normalized.origin);
    setError(null);
    setTesting(true);
    setOutcome(null);
    void test(normalized.origin)
      .then((result) => setOutcome(testOutcome(result, hostPort(normalized.origin))))
      .finally(() => setTesting(false));
  };

  const submit = (): void => {
    const normalized = normalizeEndpointUrl(url);
    if (!normalized.ok) {
      setError(normalized.error);
      return;
    }
    if (takenUrls.some((taken) => taken === normalized.origin && taken !== editing?.baseUrl)) {
      setError('That address is already set up.');
      return;
    }
    const trimmed = name.trim();
    onSave({
      // Kept across an edit, because every model chosen from this server names
      // it by this id - a new one would orphan the user's own selection.
      id: editing?.id ?? newEndpointId(),
      baseUrl: normalized.origin,
      name: trimmed === '' ? null : trimmed,
      enabled: editing?.enabled ?? true,
      // What a probe last found here, kept through an edit of the label and
      // dropped when the address itself changes - a different port is a
      // different server, and its old roster would be a lie about the new one.
      lastKnownModels:
        editing !== null && editing.baseUrl === normalized.origin ? editing.lastKnownModels : []
    });
  };

  return (
    <Overlay
      open={open}
      onClose={onCancel}
      panelClassName="w-[520px] bg-fleet-surface border border-fleet-border-strong rounded-xl overflow-hidden"
    >
      <div className="flex items-center gap-3 px-5 pt-5 pb-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg fleet-accent-bg-soft fleet-accent-text">
          <HardDrive size={17} />
        </div>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-fleet-text">
            {editing === null ? 'Add a local server' : 'Edit server'}
          </h2>
          <p className="text-xs text-fleet-text-muted">
            Its models join the pickers above, alongside the OpenRouter ones.
          </p>
        </div>
      </div>

      <div className="space-y-4 border-t border-fleet-border px-5 py-4">
        <Field
          label="Address"
          description="Where the server is listening. Fleet takes every model it serves - and a plain llama-server serves one, so a second model there is a second entry here."
          layout="stack"
          htmlFor="endpoint-url"
        >
          <div className="flex items-center gap-2">
            <input
              id="endpoint-url"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                // Cleared on the first keystroke, per Baymard: an answer about
                // the address as it was reads as an answer about this one.
                setError(null);
                setOutcome(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runTest();
              }}
              spellCheck={false}
              autoComplete="off"
              placeholder="http://127.0.0.1:11437"
              className={`${inputCls} w-full font-mono`}
            />
            <button
              type="button"
              onClick={runTest}
              disabled={testing || url.trim() === ''}
              className="flex shrink-0 items-center gap-1.5 rounded-md border border-fleet-border-strong px-3 py-1.5 text-xs text-fleet-text-secondary transition-colors hover:bg-fleet-surface-2 disabled:opacity-40 focus-ring"
            >
              {testing && <Loader2 size={12} className="animate-spin" />}
              Test
            </button>
          </div>
        </Field>

        {outcome !== null && <Outcome outcome={outcome} />}

        <Field
          label="Name"
          description="Optional. Without one it is known by its address, which is usually clearer."
          layout="stack"
          htmlFor="endpoint-name"
        >
          <input
            id="endpoint-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            placeholder="Workstation"
            className={`${inputCls} w-full`}
          />
        </Field>
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

/** What Test found. Never a reason not to save - see the note at the top. */
function Outcome({ outcome }: { outcome: TestOutcome }): React.JSX.Element {
  const look =
    outcome.tone === 'ok'
      ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-200'
      : 'border-amber-500/25 bg-amber-500/10 text-amber-200';
  return (
    <div className={`flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs ${look}`}>
      {outcome.tone === 'ok' ? (
        <CheckCircle2 size={13} className="mt-px shrink-0" />
      ) : (
        <TriangleAlert size={13} className="mt-px shrink-0" />
      )}
      <span className="min-w-0">
        <span className="block font-medium">{outcome.title}</span>
        <span className="block opacity-90">{outcome.hint}</span>
        {outcome.tone === 'warn' && (
          <span className="mt-1 block opacity-75">
            You can still save it - Fleet will check again when the server is up.
          </span>
        )}
      </span>
    </div>
  );
}
