// src/renderer/src/components/sessions/TranscriptView.tsx
import { useMemo, useState } from 'react';
import type {
  SessionSummary,
  SubagentSummary,
  TranscriptBlock,
  TranscriptMessage
} from '../../../../shared/sessions';
import { useSessionsStore } from '../../store/sessions-store';
import { useWorkspaceStore } from '../../store/workspace-store';
import { SessionTree } from './SessionTree';
import { DistillModal } from './DistillModal';
import { pathToNode } from './tree-utils';

function resumeCommand(s: SessionSummary): string {
  return s.agent === 'rune' ? `rune --resume ${s.id}` : `claude --resume ${s.id}`;
}

function Block({ block }: { block: TranscriptBlock }): React.JSX.Element {
  switch (block.type) {
    case 'text':
      return (
        <div className="whitespace-pre-wrap break-words text-sm text-fleet-text">{block.text}</div>
      );
    case 'tool_use':
      return (
        <div className="whitespace-pre-wrap break-words text-xs text-fleet-text-subtle font-mono">
          ⚙ {block.name} <span className="opacity-60">{block.argsPreview}</span>
        </div>
      );
    case 'tool_result':
      return (
        <div
          className={`whitespace-pre-wrap break-words text-xs font-mono ${block.isError ? 'text-red-400' : 'text-fleet-text-subtle'}`}
        >
          ↳ {block.output.slice(0, 2000)}
        </div>
      );
    case 'image':
      return <div className="text-xs text-fleet-text-subtle italic">[image]</div>;
  }
}

function Message({ message }: { message: TranscriptMessage }): React.JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`flex flex-col gap-1 ${isUser ? 'items-end' : 'items-start'}`}>
      <span className="text-[10px] uppercase tracking-wider text-fleet-text-subtle">
        {message.role}
      </span>
      <div
        className={`min-w-0 max-w-[85%] rounded-md px-3 py-2 ${
          isUser ? 'bg-blue-600/20' : 'bg-fleet-surface-2/60'
        } flex flex-col gap-1`}
      >
        {message.blocks.map((b, i) => (
          <Block key={i} block={b} />
        ))}
      </div>
    </div>
  );
}

function SubagentList({ subagents }: { subagents: SubagentSummary[] }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-fleet-text-subtle">
        Subagents
      </div>
      {subagents.map((sa) => (
        <div key={sa.id} className="rounded bg-fleet-surface-2/40 px-2 py-1 text-xs">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-fleet-text">
              {sa.name.length > 0 ? sa.name : '(unnamed)'}
            </span>
            <span className="flex-shrink-0 rounded bg-fleet-surface-2 px-1 text-[10px] text-fleet-text-subtle">
              {sa.status}
            </span>
          </div>
          {sa.agentType ? (
            <div className="truncate text-[10px] text-fleet-text-subtle">{sa.agentType}</div>
          ) : null}
          {sa.summary ? (
            <div className="mt-0.5 line-clamp-3 text-[11px] text-fleet-text-subtle">
              {sa.summary}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function TranscriptView({
  onDistilled
}: {
  /** Fired after a distill is saved, so the Learnings list can refresh. */
  onDistilled?: () => void;
} = {}): React.JSX.Element {
  const { selected, transcript, selectedNodeId, selectNode, isLoadingTranscript, transcriptError } =
    useSessionsStore();
  const openResumeTab = useWorkspaceStore((s) => s.openResumeTab);
  const [showRail, setShowRail] = useState(true);
  const [distilling, setDistilling] = useState(false);

  const tree = transcript?.tree;
  const subagents = transcript?.subagents;
  const hasRail = Boolean(tree) || (subagents !== undefined && subagents.length > 0);

  // When the session branches, distill the path the user is currently viewing.
  const distillNodeId = tree ? (selectedNodeId ?? tree.activeId) : undefined;
  const onBranch = Boolean(tree) && selectedNodeId !== null && selectedNodeId !== tree?.activeId;

  const messages = useMemo<TranscriptMessage[]>(() => {
    if (!transcript) return [];
    return tree ? pathToNode(tree, selectedNodeId) : transcript.messages;
  }, [transcript, tree, selectedNodeId]);

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fleet-text-subtle">
        Select a session to view its transcript.
      </div>
    );
  }
  if (transcriptError) {
    return (
      <div className="flex h-full items-center justify-center px-6 text-center text-sm text-red-400">
        {transcriptError}
      </div>
    );
  }
  if (isLoadingTranscript || !transcript) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fleet-text-subtle">
        Loading…
      </div>
    );
  }

  const s = transcript.summary;
  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="flex items-center justify-between border-b border-fleet-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fleet-text">{s.title}</div>
          <div className="text-xs text-fleet-text-subtle">
            {s.agent} {s.provider ? `· ${s.provider}` : ''} {s.model ? `· ${s.model}` : ''} ·{' '}
            {messages.length} msgs
          </div>
        </div>
        <div className="flex flex-shrink-0 items-center gap-2">
          {hasRail ? (
            <button
              onClick={() => setShowRail((v) => !v)}
              className="rounded border border-fleet-border-strong px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
            >
              {showRail ? '⌹ Hide branches' : '⌹ Branches'}
            </button>
          ) : null}
          <button
            onClick={() => setDistilling(true)}
            className="rounded border border-fleet-border-strong px-2 py-1.5 text-xs text-fleet-text-subtle hover:bg-fleet-surface-2/50"
            title={
              onBranch
                ? 'Distill a reusable learning from this branch'
                : 'Distill a reusable learning from this session'
            }
          >
            ✨ Distill {onBranch ? 'branch' : 'learning'}
          </button>
          <button
            onClick={() => openResumeTab(s.cwd, resumeCommand(s), s.title)}
            className="rounded bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
          >
            Resume ▸
          </button>
        </div>
      </div>
      <DistillModal
        open={distilling}
        session={s}
        nodeId={distillNodeId}
        onClose={() => setDistilling(false)}
        onSaved={onDistilled}
      />
      <div className="flex min-h-0 flex-1">
        {hasRail && showRail ? (
          <div className="flex w-64 flex-shrink-0 flex-col gap-3 overflow-y-auto border-r border-fleet-border px-2 py-3">
            {tree ? (
              <SessionTree tree={tree} selectedNodeId={selectedNodeId} onSelect={selectNode} />
            ) : null}
            {subagents && subagents.length > 0 ? <SubagentList subagents={subagents} /> : null}
          </div>
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3">
          {messages.map((m, i) => (
            <Message key={i} message={m} />
          ))}
        </div>
      </div>
    </div>
  );
}
