import { useEffect, useRef, useState } from 'react';
import { useRemoteStore } from '../../store/remote-store';
import { useRemoteCwdStore } from '../../store/remote-cwd-store';
import { useSettingsStore } from '../../store/settings-store';
import { toRemoteHost, type RemoteHost } from '../../../../shared/remote-ssh-types';
import { createLogger } from '../../logger';
import { InstallRcSnippetDialog } from './InstallRcSnippetDialog';

const log = createLogger('remote-rc-prompt');

/**
 * Fleet needs the remote shell's help to know where it is standing. This offers
 * to install it, once, the first time the user SSHes somewhere new.
 *
 * The wait before asking is the point: a host that already has the snippet
 * starts reporting its directory within a prompt or two, and asking those users
 * anything at all would be noise. Only silence after the grace period means
 * there is really nothing installed.
 */
const GRACE_MS = 6_000;

type Pending = {
  paneId: string;
  host: RemoteHost;
  destination: string;
  /** The snippet is already there, just an older version of it. */
  update: boolean;
};

export function RemoteRcPromptManager(): React.JSX.Element {
  const remotes = useRemoteStore((s) => s.remotes);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const [pending, setPending] = useState<Pending | null>(null);
  // Panes already looked at. A pane is considered once per app run: a user who
  // says "not now" should not be asked again on their next `cd`.
  const consideredRef = useRef(new Set<string>());
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!settings) return;
    const consent = settings.remoteSsh.rcConsent;
    const timers = timersRef.current;

    for (const paneId of remotes) {
      if (consideredRef.current.has(paneId)) continue;
      consideredRef.current.add(paneId);
      // Held per pane rather than cleared on every re-run: this effect fires
      // again the moment any *other* pane connects, and a shared cleanup would
      // cancel a wait that has not finished.
      timers.set(
        paneId,
        setTimeout(() => {
          timers.delete(paneId);
          void consider(paneId, consent, setPending);
        }, GRACE_MS)
      );
    }
  }, [remotes, settings]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // A pane that closes or disconnects can be asked about again next time.
  useEffect(() => {
    for (const paneId of consideredRef.current) {
      if (!remotes.has(paneId)) {
        consideredRef.current.delete(paneId);
        const timer = timersRef.current.get(paneId);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(paneId);
        }
      }
    }
  }, [remotes]);

  const remember = async (destination: string, answer: 'installed' | 'declined'): Promise<void> => {
    const current = useSettingsStore.getState().settings?.remoteSsh.rcConsent ?? {};
    await updateSettings({ remoteSsh: { rcConsent: { ...current, [destination]: answer } } });
  };

  return (
    <InstallRcSnippetDialog
      destination={pending?.destination ?? null}
      update={pending?.update ?? false}
      onInstall={async () => {
        if (!pending) return null;
        const result = await window.fleet.remoteSsh.rcInstall(pending.host, pending.paneId);
        if (!result.success) return result.error;
        await remember(pending.destination, 'installed');
        setPending(null);
        return null;
      }}
      onDecline={() => {
        if (pending) void remember(pending.destination, 'declined');
        setPending(null);
      }}
    />
  );
}

/**
 * Decide whether this pane should be offered the snippet, and say so.
 *
 * Everything here is a reason *not* to ask: the shell is already reporting, the
 * user answered for this host before, or the file is already on the far side
 * (adopted silently - someone who installed it by hand has already agreed).
 */
async function consider(
  paneId: string,
  consent: Record<string, 'installed' | 'declined'>,
  setPending: (update: (previous: Pending | null) => Pending | null) => void
): Promise<void> {
  if (useRemoteCwdStore.getState().cwds.has(paneId)) return;
  if (!useRemoteStore.getState().remotes.has(paneId)) return;

  const detected = await window.fleet.remoteSsh.detectHost(paneId);
  if (!detected.success || !detected.data) return;

  const destination = detected.data.destination;
  // Only a decline is final. A host the user already said yes to is still asked
  // again when the snippet on it is out of date, which is the whole point of
  // versioning it.
  if (consent[destination] === 'declined') return;

  const host = toRemoteHost(detected.data);
  const status = await window.fleet.remoteSsh.rcStatus(host);
  if (!status.success) {
    log.debug('rcStatus failed', { destination, error: status.error });
    return;
  }
  if (status.data.installed && status.data.current) return;

  // One question at a time: a second pane connecting must not swap the host name
  // out from under a dialog the user is reading.
  const update = status.data.installed;
  setPending((previous) => previous ?? { paneId, host, destination, update });
}
