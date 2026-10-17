import { useState } from 'react';
import {
  ClipboardList,
  Copy,
  File,
  FileText,
  GitBranch,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Link,
  MessageSquareText,
  type LucideIcon
} from 'lucide-react';
import type {
  AgencyResult,
  PrState,
  ResultFile,
  ResultMergeStatus
} from '../../../../shared/agency-jobs';
import type { DeliverableKind } from '../../../../shared/agency-plan';
import { isBinaryBlockedFilePath } from '../../../../shared/file-open';
import { toFleetImageUrl } from '../../../../shared/path-platform';
import { formatSize } from '../../lib/file-display';
import { useWorkspaceStore } from '../../store/workspace-store';
import { OnboardingButton } from './onboarding-ui';

const KIND_ICON: Record<DeliverableKind, LucideIcon> = {
  pr: GitPullRequest,
  branch: GitBranch,
  doc: FileText,
  image: ImageIcon,
  copy: Copy,
  preview: Globe,
  review: MessageSquareText,
  report: ClipboardList,
  file: File,
  link: Link
};

const openLink = (url: string): void => void window.fleet.shell.openExternal(url);
const openInFleet = (path: string): void => void useWorkspaceStore.getState().openFile(path);

/**
 * Something a step handed back, as a card: a PR with its checks, a branch,
 * copy to take, a link, or files copied out of the worktree. The heading is
 * the deliverable's label in the client's words, and the step it came from.
 */
export function ResultCard({ result }: { result: AgencyResult }): React.JSX.Element {
  const Icon = KIND_ICON[result.kind];
  return (
    <section
      aria-label={`${result.label}: ${result.title}`}
      className="flex flex-col gap-1.5 rounded-md border border-fleet-border bg-fleet-bg p-2.5"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-fleet-text-muted">
        <Icon size={12} className="shrink-0" />
        <span className="truncate font-medium">{result.label}</span>
        {!result.listed && (
          <span className="shrink-0 rounded border border-fleet-border px-1 text-[10px] text-fleet-text-subtle">
            extra
          </span>
        )}
        <span className="ml-auto shrink-0 font-mono text-fleet-text-subtle">{result.stepId}</span>
      </div>
      <ResultBody result={result} />
    </section>
  );
}

function ResultBody({ result }: { result: AgencyResult }): React.JSX.Element {
  const { body } = result;
  switch (body.kind) {
    case 'pr':
      return (
        <PrBody
          pr={body.pr}
          changed={result.changedAfterDelivery}
          member={result.member}
          merge={result.merge?.status ?? null}
        />
      );
    case 'branch':
      return (
        <p className="text-xs text-fleet-text-secondary">
          <span className="font-mono">{body.branch}</span>{' '}
          <span className="font-mono text-fleet-text-subtle">{body.sha.slice(0, 7)}</span>
        </p>
      );
    case 'copy':
      return <CopyBody title={result.title} text={body.text} />;
    case 'preview':
    case 'link':
      return (
        <>
          <Title>{result.title}</Title>
          <p className="truncate font-mono text-[11px] text-fleet-text-subtle" title={body.url}>
            {body.url}
          </p>
          <Actions>
            <OnboardingButton onClick={() => openLink(body.url)}>Open in browser</OnboardingButton>
          </Actions>
        </>
      );
    case 'doc':
    case 'image':
    case 'review':
    case 'report':
    case 'file':
      return (
        <>
          <Title>{result.title}</Title>
          {body.kind === 'image' ? (
            <Gallery files={body.files} />
          ) : (
            <FileRows resultId={result.id} files={body.files} />
          )}
        </>
      );
  }
}

function Title({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-[13px] font-medium text-fleet-text">{children}</span>;
}

function Actions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex flex-wrap gap-1.5 pt-0.5">{children}</div>;
}

const PR_STATE: Record<PrState['state'] | 'draft', { label: string; className: string }> = {
  open: { label: 'Open', className: 'text-green-700 dark:text-green-400' },
  draft: { label: 'Draft', className: 'text-fleet-text-muted' },
  merged: { label: 'Merged', className: 'text-purple-700 dark:text-purple-400' },
  closed: { label: 'Closed', className: 'text-red-600 dark:text-red-400' }
};

/** Where an open PR stands in the job's merge; a merged one says so in its state. */
const MERGE_NOTE: Partial<Record<ResultMergeStatus, { label: string; className: string }>> = {
  queued: { label: 'Queued to merge', className: 'text-fleet-text-secondary' },
  failed: { label: 'The merge stopped here', className: 'text-amber-700 dark:text-amber-400/90' }
};

function PrBody({
  pr,
  changed,
  member,
  merge
}: {
  pr: PrState;
  changed: boolean;
  member: string | null;
  merge: ResultMergeStatus | null;
}): React.JSX.Element {
  const state = PR_STATE[pr.state === 'open' && pr.draft ? 'draft' : pr.state];
  const mergeNote = pr.state === 'open' && merge !== null ? MERGE_NOTE[merge] : undefined;
  const { passed, failed, pending } = pr.checks;
  return (
    <>
      <Title>{pr.title}</Title>
      <p className="flex flex-wrap items-baseline gap-x-2 text-[11px] text-fleet-text-muted">
        <span className={`font-medium ${state.className}`}>{state.label}</span>
        {member !== null && <span className="font-medium text-fleet-text-secondary">{member}</span>}
        <span className="font-mono">#{pr.number}</span>
        <span className="min-w-0 truncate font-mono">
          {pr.branch} → {pr.base}
        </span>
      </p>
      <p className="flex flex-wrap gap-x-2 text-[11px] text-fleet-text-muted">
        <span>
          <span className="text-green-700 dark:text-green-400">+{pr.additions}</span>{' '}
          <span className="text-red-600 dark:text-red-400">−{pr.deletions}</span>
        </span>
        <span>
          {pr.changedFiles} {pr.changedFiles === 1 ? 'file' : 'files'}
        </span>
        {passed + failed + pending > 0 && (
          <span>
            Checks: {passed} passed
            {failed > 0 && (
              <span className="text-red-600 dark:text-red-400">, {failed} failed</span>
            )}
            {pending > 0 && `, ${pending} pending`}
          </span>
        )}
      </p>
      {changed && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400/90">Changed after delivery</p>
      )}
      {mergeNote !== undefined && (
        <p className={`text-[11px] ${mergeNote.className}`}>{mergeNote.label}</p>
      )}
      <Actions>
        <OnboardingButton onClick={() => openLink(pr.url)}>Open PR</OnboardingButton>
      </Actions>
    </>
  );
}

function CopyBody({ title, text }: { title: string; text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <>
      <Title>{title}</Title>
      <p className="max-h-40 overflow-y-auto rounded border border-fleet-border bg-fleet-surface px-2 py-1.5 text-xs leading-relaxed whitespace-pre-wrap text-fleet-text-secondary">
        {text}
      </p>
      <Actions>
        <OnboardingButton
          onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
        >
          {copied ? 'Copied' : 'Copy'}
        </OnboardingButton>
      </Actions>
    </>
  );
}

/** Images as thumbnails; one opens in a Fleet image pane. */
function Gallery({ files }: { files: ResultFile[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {files.map((file) => (
        <button
          key={file.path}
          type="button"
          title={file.name}
          aria-label={`Open ${file.name}`}
          onClick={() => openInFleet(file.path)}
          className="aspect-square overflow-hidden rounded border border-fleet-border bg-fleet-surface transition-opacity hover:opacity-85 focus-ring"
        >
          <img src={toFleetImageUrl(file.path)} alt="" className="h-full w-full object-cover" />
        </button>
      ))}
    </div>
  );
}

/** Files by name, type and size, each opened in Fleet, with its app, or in Finder. */
function FileRows({
  resultId,
  files
}: {
  resultId: number;
  files: ResultFile[];
}): React.JSX.Element {
  const [error, setError] = useState<string | null>(null);
  const openWithApp = (file: number): void =>
    void window.fleet.agency.openResult({ resultId, file }).then((e) => setError(e || null));
  return (
    <ul className="flex flex-col gap-1.5">
      {files.map((file, i) => (
        <li key={file.path} className="flex flex-col gap-1">
          <p className="flex items-baseline gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-fleet-text-secondary" title={file.name}>
              {file.name}
            </span>
            <span className="shrink-0 text-[11px] text-fleet-text-subtle">
              {file.type} · {formatSize(file.size)}
            </span>
          </p>
          <Actions>
            {!isBinaryBlockedFilePath(file.path) && (
              <OnboardingButton onClick={() => openInFleet(file.path)}>
                Open in Fleet
              </OnboardingButton>
            )}
            <OnboardingButton onClick={() => openWithApp(i)}>Open</OnboardingButton>
            <OnboardingButton onClick={() => void window.fleet.file.reveal(file.path)}>
              Show in Finder
            </OnboardingButton>
          </Actions>
        </li>
      ))}
      {error !== null && (
        <p role="status" className="text-[11px] text-amber-700 dark:text-amber-400/90">
          {error}
        </p>
      )}
    </ul>
  );
}
