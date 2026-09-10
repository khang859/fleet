import { useEffect, useRef, useState } from 'react';
import { useClaudeConfigStore } from '../../store/claude-config-store';
import { parseSettings } from '../../lib/claude-json-edit';
import { summarizeChanges, changedKeys, formatList } from '../../lib/claude-change-summary';
import type { ClaudeConfigScope, ClaudeFileKind } from '../../../../shared/claude-config';
import type { ClaudeWriteRefusal } from '../../../../shared/claude-config-types';
import type { SettingsSectionProps } from './SettingsTab';

/**
 * The save bar, and everything a save can come back with.
 *
 * It floats: a pill that sticks to the bottom of the scroll area rather than a
 * footer parked under the last field. The form is long enough that a footer is
 * off screen exactly when the user has finished editing, and a pill that names
 * what changed - "3 unsaved changes in Permissions" - lets them decide without
 * scrolling back.
 *
 * The refusals are kept apart on purpose. "Someone else changed this file" and
 * "this file is gone" need different answers from the user, and one generic
 * "could not save" would hide which of them happened.
 */

const REFUSAL_TEXT: Record<ClaudeWriteRefusal, string> = {
  modified: 'This file changed on disk after Fleet loaded it.',
  deleted: 'This file was deleted after Fleet loaded it.',
  created: 'This file was created by something else after Fleet loaded it.',
  missingDir: 'Fleet could not create the folder for this file.',
  invalidJson: 'Fleet will not write this text because it is not valid JSON.',
  refused: 'Fleet refused this path. It is not one of the files this page may edit.',
  failed: 'Writing the file failed.'
};

/** Which refusals a reload or an overwrite can actually resolve. */
const RECOVERABLE = new Set<ClaudeWriteRefusal>(['modified', 'deleted', 'created']);

/**
 * What saving this scope reaches.
 *
 * Only the shared project file leaves the machine, so only that one gets a
 * sentence. Saying it on all three would train the user to skip it.
 */
const BLAST_RADIUS: Partial<Record<ClaudeConfigScope, string>> = {
  project:
    'This file is committed to git, so everyone who clones the repository gets these settings.'
};

function isRefusal(reason: string): reason is ClaudeWriteRefusal {
  return reason in REFUSAL_TEXT;
}

/**
 * A bordered message above the pill, in the colour its news deserves.
 *
 * Class strings rather than a wrapper component: three call sites, each with
 * different content, and a component here would be one more indirection between
 * the reader and what the message actually says.
 */
const NOTICE_BASE = 'pointer-events-auto rounded-lg border px-3 py-2 text-xs shadow-lg';
const WARN_NOTICE = `${NOTICE_BASE} border-amber-500/40 bg-amber-500/10 text-amber-300`;
const ERROR_NOTICE = `${NOTICE_BASE} border-red-500/40 bg-red-500/10 text-red-300`;

/** An action that reads as part of the sentence around it. */
const LINK_CLS = 'underline underline-offset-2 transition active:scale-[0.97]';

export function ClaudeConfigSaveBar({
  scope,
  kind,
  path,
  dirty,
  onNavigate
}: {
  scope: ClaudeConfigScope;
  kind: ClaudeFileKind;
  path: string;
  dirty: boolean;
  onNavigate?: SettingsSectionProps['onNavigate'];
}): React.JSX.Element | null {
  const doc = useClaudeConfigStore((s) => s.documents[path]);
  const save = useClaudeConfigStore((s) => s.save);
  const reload = useClaudeConfigStore((s) => s.reload);
  const edit = useClaudeConfigStore((s) => s.edit);
  const dismissNotice = useClaudeConfigStore((s) => s.dismissNotice);
  const staleOnDisk = useClaudeConfigStore((s) => s.staleOnDisk[path] ?? false);

  // A settings file that does not parse cannot be written at all, so the block
  // belongs on the button rather than only in the editor's gutter.
  const unparseable = kind === 'settings' && parseSettings(doc?.text ?? '{}') === null;
  const canSave = dirty && !unparseable && path !== '';

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 's') return;
      if (!canSave) return;
      event.preventDefault();
      runSave();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // `runSave` is rebuilt every render; the values it closes over are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSave, save, scope, kind, path]);

  const conflict = doc?.conflict;
  const reason = conflict && isRefusal(conflict.reason) ? conflict.reason : undefined;
  const recoverable = reason !== undefined && RECOVERABLE.has(reason);

  // What the other writer touched, read at the moment of the refusal. Naming
  // the keys is what turns "reload or overwrite?" into a decision the user can
  // actually make.
  const [theirKeys, setTheirKeys] = useState<string[]>([]);
  // A request counter rather than a cleanup flag: the read is fired again on
  // every refusal, and only the newest answer may reach the screen.
  const readId = useRef(0);
  useEffect(() => {
    readId.current += 1;
    const id = readId.current;
    if (!recoverable || kind !== 'settings' || !doc) {
      setTheirKeys([]);
      return;
    }
    void (async () => {
      let keys: string[] = [];
      try {
        const dirs = useClaudeConfigStore.getState().dirs();
        const disk = await window.fleet.claudeConfig.read({ scope, kind, dirs });
        keys = changedKeys(disk.text, doc.text);
      } catch {
        keys = [];
      }
      if (readId.current === id) setTheirKeys(keys);
    })();
  }, [recoverable, scope, kind, doc]);

  // A save that only clears the dirty state is indistinguishable from a save
  // that never ran. The pill stays for a moment and says so.
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);

  const runSave = (opts?: { overwrite?: boolean }): void => {
    void save(scope, kind, path, opts).then((result) => {
      if (result?.ok) setSaved(true);
    });
  };

  const summary =
    kind === 'settings'
      ? summarizeChanges(doc?.savedText ?? '{}', doc?.text ?? '{}')
      : { count: 0, sections: [], label: 'Unsaved changes' };

  const showPill = dirty || saved;
  const showAnything = showPill || staleOnDisk || conflict !== undefined || doc?.hooksDiscarded;
  if (!showAnything) return null;

  return (
    // Sticky rather than fixed: the pill rides the settings scroll area, so it
    // never covers another page and needs no measuring.
    <div className="pointer-events-none sticky bottom-4 z-10 flex flex-col items-center gap-2">
      {staleOnDisk ? (
        <div className={WARN_NOTICE}>
          This file changed on disk while you were editing. Your edits are kept.{' '}
          <button onClick={() => void reload(scope, kind, path)} className={LINK_CLS}>
            Load the disk version
          </button>
        </div>
      ) : null}

      {conflict ? (
        <div className={ERROR_NOTICE}>
          <div className="space-y-2">
            <div>{reason ? REFUSAL_TEXT[reason] : 'Saving failed.'}</div>
            {theirKeys.length > 0 ? (
              <div className="text-[11px] text-red-200/90">
                Different from your version:{' '}
                <span className="font-mono">{formatList(theirKeys)}</span>
              </div>
            ) : null}
            {conflict.message ? (
              <div className="max-w-[520px] break-words font-mono text-[11px] text-red-200/80">
                {conflict.message}
              </div>
            ) : null}
            <div className="flex items-center gap-6">
              {/* The exit that loses nothing comes first and nearest. */}
              <button
                onClick={() => dismissNotice(path)}
                className="rounded border border-red-400/50 px-2 py-0.5 transition active:scale-[0.97]"
              >
                Keep editing
              </button>
              {recoverable ? (
                <div className="flex items-center gap-3">
                  <button onClick={() => void reload(scope, kind, path)} className={LINK_CLS}>
                    Discard my edits
                  </button>
                  <button onClick={() => runSave({ overwrite: true })} className={LINK_CLS}>
                    Overwrite the file
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {doc?.hooksDiscarded ? (
        <div className={WARN_NOTICE}>
          Your change to <span className="font-mono">hooks</span> was not written. Fleet keeps the
          hooks block that is on disk.{' '}
          <button onClick={() => onNavigate?.('copilot')} className={LINK_CLS}>
            Manage hooks on the Copilot page
          </button>
        </div>
      ) : null}

      {showPill ? (
        <>
          {BLAST_RADIUS[scope] ? (
            <p className="pointer-events-auto rounded bg-fleet-surface/90 px-2 py-0.5 text-[11px] text-fleet-text-subtle">
              {BLAST_RADIUS[scope]}
            </p>
          ) : null}

          <div
            className={`pointer-events-auto flex h-10 items-center gap-3 rounded-full border border-fleet-border-strong bg-fleet-surface-2 shadow-lg ${
              dirty ? 'pl-4 pr-1.5' : 'px-4'
            }`}
          >
            <span
              className={`h-1.5 w-1.5 flex-none rounded-full ${
                dirty ? (unparseable ? 'bg-red-400' : 'bg-amber-400') : 'bg-emerald-400'
              }`}
            />
            <span className="text-xs text-fleet-text">
              {!dirty ? 'Saved' : unparseable ? 'Fix the JSON before saving' : summary.label}
            </span>
            {dirty ? (
              <>
                <button
                  onClick={() => edit(path, doc?.savedText ?? '')}
                  className="text-xs text-fleet-text-secondary transition hover:text-fleet-text active:scale-[0.97]"
                >
                  Reset
                </button>
                <button
                  disabled={!canSave}
                  onClick={() => runSave()}
                  className="fleet-accent-bg fleet-accent-bg-hover rounded-full px-3 py-1.5 text-xs text-white transition active:scale-[0.97] disabled:opacity-40"
                >
                  Save
                </button>
              </>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
