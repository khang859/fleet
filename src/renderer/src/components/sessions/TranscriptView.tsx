// src/renderer/src/components/sessions/TranscriptView.tsx
import type {
  SessionSummary,
  TranscriptBlock,
  TranscriptMessage
} from '../../../../shared/sessions';
import { useSessionsStore } from '../../store/sessions-store';
import { useWorkspaceStore } from '../../store/workspace-store';

function resumeCommand(s: SessionSummary): string {
  return s.agent === 'rune' ? `rune --resume ${s.id}` : `claude --resume ${s.id}`;
}

function Block({ block }: { block: TranscriptBlock }): React.JSX.Element {
  switch (block.type) {
    case 'text':
      return <div className="whitespace-pre-wrap text-sm text-fleet-text">{block.text}</div>;
    case 'tool_use':
      return (
        <div className="text-xs text-fleet-text-subtle font-mono">
          ⚙ {block.name} <span className="opacity-60">{block.argsPreview}</span>
        </div>
      );
    case 'tool_result':
      return (
        <div
          className={`text-xs font-mono ${block.isError ? 'text-red-400' : 'text-fleet-text-subtle'}`}
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
        className={`max-w-[85%] rounded-md px-3 py-2 ${
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

export function TranscriptView(): React.JSX.Element {
  const { selected, transcript, isLoadingTranscript } = useSessionsStore();
  const openResumeTab = useWorkspaceStore((s) => s.openResumeTab);

  if (!selected) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-fleet-text-subtle">
        Select a session to view its transcript.
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
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-fleet-border px-4 py-3">
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-fleet-text">{s.title}</div>
          <div className="text-xs text-fleet-text-subtle">
            {s.agent} {s.provider ? `· ${s.provider}` : ''} {s.model ? `· ${s.model}` : ''} ·{' '}
            {s.messageCount} msgs
          </div>
        </div>
        <button
          onClick={() => openResumeTab(s.cwd, resumeCommand(s), s.title)}
          className="flex-shrink-0 rounded bg-blue-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-600"
        >
          Resume ▸
        </button>
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
        {transcript.messages.map((m, i) => (
          <Message key={i} message={m} />
        ))}
      </div>
    </div>
  );
}
