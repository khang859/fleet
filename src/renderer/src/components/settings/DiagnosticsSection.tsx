import { useState, useEffect } from 'react';
import type { DiagnosticsInfo } from '../../../../shared/ipc-api';

const REPO = 'khang859/fleet';
// Keep the prefilled issue URL comfortably under browser/GitHub limits.
const MAX_URL_LENGTH = 7000;

function buildIssueUrl(info: DiagnosticsInfo, logSnippet: string): string {
  const title = `Bug: <short summary> (v${info.version})`;

  const build = (snippet: string): string => {
    const body = [
      '## Describe the problem',
      '',
      '<!-- What happened? What did you expect to happen? -->',
      '',
      '## Environment',
      `- Fleet: v${info.version}`,
      `- OS: ${info.platform} ${info.arch} (${info.osRelease})`,
      `- Electron ${info.electron} · Chrome ${info.chrome} · Node ${info.node}`,
      '',
      '## Recent logs',
      'Secrets and paths are redacted, but please review before posting. For the full logs,',
      'click "Open Logs Folder" in Settings → Diagnostics and attach the latest `fleet-*.log`.',
      '',
      '```',
      snippet.trim() || '(no recent log entries)',
      '```'
    ].join('\n');
    return `https://github.com/${REPO}/issues/new?labels=bug&title=${encodeURIComponent(
      title
    )}&body=${encodeURIComponent(body)}`;
  };

  // Shrink the embedded log snippet until the URL fits. encodeURIComponent can
  // expand each char up to ~3x, so check the encoded URL length (not the raw
  // snippet length) and halve the snippet to 0 if needed; the snippet-less URL
  // is always well under the limit.
  let snippet = logSnippet.slice(-3000);
  let url = build(snippet);
  while (url.length > MAX_URL_LENGTH && snippet.length > 0) {
    // ceil so a length-1 snippet drops to 0 (floor would stay at 1 forever).
    snippet = snippet.slice(Math.ceil(snippet.length / 2));
    url = build(snippet);
  }
  return url;
}

export function DiagnosticsSection(): React.JSX.Element {
  const [info, setInfo] = useState<DiagnosticsInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.fleet.diagnostics.getInfo().then(setInfo);
  }, []);

  const reportProblem = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const current = info ?? (await window.fleet.diagnostics.getInfo());
      const logTail = await window.fleet.diagnostics.getLogTail();
      await window.fleet.shell.openExternal(buildIssueUrl(current, logTail));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to open report');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-1">
        <div className="text-sm text-neutral-300">{info ? `Fleet v${info.version}` : 'Fleet'}</div>
        {info && (
          <div className="text-xs text-neutral-500">
            {info.platform} {info.arch} · Electron {info.electron} · Chrome {info.chrome}
          </div>
        )}
      </div>

      <p className="text-sm text-neutral-400">
        Hit a bug? Report a Problem opens a prefilled GitHub issue with your version, OS, and a
        redacted snippet of recent logs. For the full logs, open the logs folder and attach the
        latest <code className="text-neutral-300">fleet-*.log</code> file. Nothing is sent anywhere
        until you submit the issue.
      </p>

      <div className="flex gap-2">
        <button
          onClick={() => {
            void reportProblem();
          }}
          disabled={busy}
          className="px-3 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97] disabled:active:scale-100"
        >
          {busy ? 'Opening…' : 'Report a Problem'}
        </button>
        <button
          onClick={() => {
            void window.fleet.diagnostics.openLogsFolder();
          }}
          className="px-3 py-1.5 text-sm bg-neutral-700 hover:bg-neutral-600 text-white rounded-md transition-colors active:scale-[0.97]"
        >
          Open Logs Folder
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}
    </div>
  );
}
