import { useState, useRef, useEffect, useCallback } from 'react';
import { useStarCommandStore } from '../store/star-command-store';
import type { AdmiralChatMessage } from '../store/star-command-store';
import { useWorkspaceStore } from '../store/workspace-store';
import { IPC_CHANNELS } from '../../../shared/constants';

function MessageBubble({ msg }: { msg: AdmiralChatMessage }) {
  const [toolExpanded, setToolExpanded] = useState(false);

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] px-3 py-2 rounded-lg bg-blue-600 text-white text-sm whitespace-pre-wrap">
          {msg.content}
        </div>
      </div>
    );
  }

  if (msg.role === 'tool') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[80%] px-3 py-1.5 rounded-lg bg-neutral-800 border border-neutral-700 text-xs">
          <button
            className="flex items-center gap-1 text-neutral-400 hover:text-neutral-200"
            onClick={() => setToolExpanded(!toolExpanded)}
          >
            <span className="text-xs">{toolExpanded ? '▼' : '▶'}</span>
            <span className="font-mono">{msg.toolName}</span>
            {msg.toolResult ? (
              <span className="text-green-400 ml-1">done</span>
            ) : (
              <span className="text-yellow-400 ml-1 animate-pulse">running...</span>
            )}
          </button>
          {toolExpanded && (
            <div className="mt-1 space-y-1">
              {msg.toolInput && (
                <pre className="text-neutral-500 overflow-x-auto text-xs">
                  {JSON.stringify(msg.toolInput, null, 2)}
                </pre>
              )}
              {msg.toolResult && (
                <pre className="text-neutral-400 overflow-x-auto text-xs max-h-32 overflow-y-auto">
                  {msg.toolResult}
                </pre>
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  // assistant
  return (
    <div className="flex justify-start">
      <div className="max-w-[80%] px-3 py-2 rounded-lg bg-neutral-800 text-neutral-100 text-sm whitespace-pre-wrap">
        {msg.content}
      </div>
    </div>
  );
}

function StatusPanel() {
  const { crewList, missionQueue, sectors, statusPanelOpen } = useStarCommandStore();
  const { setActiveTab } = useWorkspaceStore();

  if (!statusPanelOpen) return null;

  const activeCrew = crewList.filter((c) => c.status === 'active');
  const queuedMissions = missionQueue.filter((m) => m.status === 'queued');
  const activeMissions = missionQueue.filter((m) => m.status === 'active');

  return (
    <div className="w-72 border-l border-neutral-800 bg-neutral-900 overflow-y-auto flex-shrink-0">
      <div className="p-3 space-y-4">
        {/* Active Crew */}
        <section>
          <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
            Active Crew ({activeCrew.length})
          </h3>
          {activeCrew.length === 0 ? (
            <p className="text-xs text-neutral-600">No active Crewmates</p>
          ) : (
            <div className="space-y-1.5">
              {activeCrew.map((crew) => (
                <button
                  key={crew.id}
                  className="w-full text-left px-2 py-1.5 rounded bg-neutral-800 hover:bg-neutral-750 transition-colors"
                  onClick={() => {
                    if (crew.tab_id) setActiveTab(crew.tab_id);
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 flex-shrink-0" />
                    <span className="text-xs text-neutral-200 truncate font-mono">{crew.id}</span>
                  </div>
                  <div className="text-xs text-neutral-500 truncate ml-3.5">
                    {crew.sector_id} — {crew.mission_summary ?? 'no mission'}
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>

        {/* Mission Queue */}
        <section>
          <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
            Missions ({activeMissions.length} active, {queuedMissions.length} queued)
          </h3>
          {activeMissions.length + queuedMissions.length === 0 ? (
            <p className="text-xs text-neutral-600">No missions</p>
          ) : (
            <div className="space-y-1">
              {activeMissions.map((m) => (
                <div key={m.id} className="px-2 py-1 rounded bg-neutral-800 text-xs">
                  <span className="text-green-400 font-mono">#{m.id}</span>{' '}
                  <span className="text-neutral-300">{m.summary}</span>
                  <div className="text-neutral-500">{m.sector_id}</div>
                </div>
              ))}
              {queuedMissions.map((m) => (
                <div key={m.id} className="px-2 py-1 rounded bg-neutral-800/50 text-xs">
                  <span className="text-neutral-500 font-mono">#{m.id}</span>{' '}
                  <span className="text-neutral-400">{m.summary}</span>
                  <div className="text-neutral-600">{m.sector_id}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Sectors */}
        <section>
          <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2">
            Sectors ({sectors.length})
          </h3>
          {sectors.length === 0 ? (
            <p className="text-xs text-neutral-600">No sectors registered</p>
          ) : (
            <div className="space-y-1">
              {sectors.map((s) => (
                <div key={s.id} className="px-2 py-1 rounded bg-neutral-800 text-xs">
                  <span className="text-neutral-200 font-mono">{s.id}</span>
                  <div className="text-neutral-500">{s.stack ?? 'unknown'} — {s.name}</div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export function StarCommandTab() {
  const {
    messages,
    isStreaming,
    streamBuffer,
    addUserMessage,
    appendStreamText,
    addToolCallMessage,
    addToolResultMessage,
    finalizeAssistantMessage,
    setStreamError,
    setIsStreaming,
    setCrewList,
    setMissionQueue,
    setSectors,
    setUnreadCount,
    toggleStatusPanel,
    statusPanelOpen,
  } = useStarCommandStore();

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamBuffer]);

  // Listen for streaming chunks from main process
  useEffect(() => {
    const { ipcRenderer } = window.require?.('electron') ?? {};
    if (!ipcRenderer) return;

    const onChunk = (_e: unknown, chunk: { type: string; text?: string; name?: string; input?: Record<string, unknown>; result?: string; error?: string }) => {
      switch (chunk.type) {
        case 'text':
          appendStreamText(chunk.text ?? '');
          break;
        case 'tool_use':
          addToolCallMessage(chunk.name ?? 'unknown', chunk.input ?? {});
          break;
        case 'tool_result':
          addToolResultMessage(chunk.name ?? 'unknown', chunk.result ?? '');
          break;
        case 'done':
          finalizeAssistantMessage();
          refreshStatus();
          break;
        case 'error':
          setStreamError(chunk.error ?? 'Unknown error');
          break;
      }
    };

    const onEnd = () => finalizeAssistantMessage();
    const onError = (_e: unknown, err: { error: string }) => setStreamError(err.error);

    ipcRenderer.on(IPC_CHANNELS.ADMIRAL_STREAM_CHUNK, onChunk);
    ipcRenderer.on(IPC_CHANNELS.ADMIRAL_STREAM_END, onEnd);
    ipcRenderer.on(IPC_CHANNELS.ADMIRAL_STREAM_ERROR, onError);

    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.ADMIRAL_STREAM_CHUNK, onChunk);
      ipcRenderer.removeListener(IPC_CHANNELS.ADMIRAL_STREAM_END, onEnd);
      ipcRenderer.removeListener(IPC_CHANNELS.ADMIRAL_STREAM_ERROR, onError);
    };
  }, [appendStreamText, addToolCallMessage, addToolResultMessage, finalizeAssistantMessage, setStreamError]);

  // Listen for status updates
  useEffect(() => {
    const { ipcRenderer } = window.require?.('electron') ?? {};
    if (!ipcRenderer) return;

    const onStatus = (_e: unknown, payload: { crew?: unknown[]; missions?: unknown[]; sectors?: unknown[]; unreadCount?: number }) => {
      if (payload.crew) setCrewList(payload.crew as never[]);
      if (payload.missions) setMissionQueue(payload.missions as never[]);
      if (payload.sectors) setSectors(payload.sectors as never[]);
      if (payload.unreadCount !== undefined) setUnreadCount(payload.unreadCount);
    };

    ipcRenderer.on(IPC_CHANNELS.STARBASE_STATUS_UPDATE, onStatus);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.STARBASE_STATUS_UPDATE, onStatus);
  }, [setCrewList, setMissionQueue, setSectors, setUnreadCount]);

  // Initial status fetch and poll fallback
  const refreshStatus = useCallback(() => {
    const { ipcRenderer } = window.require?.('electron') ?? {};
    if (!ipcRenderer) return;
    ipcRenderer.invoke(IPC_CHANNELS.STARBASE_CREW).then((crew: unknown[]) => setCrewList(crew as never[]));
    ipcRenderer.invoke(IPC_CHANNELS.STARBASE_MISSIONS).then((missions: unknown[]) => setMissionQueue(missions as never[]));
    ipcRenderer.invoke(IPC_CHANNELS.STARBASE_LIST_SECTORS).then((sectors: unknown[]) => setSectors(sectors as never[]));
  }, [setCrewList, setMissionQueue, setSectors]);

  useEffect(() => {
    refreshStatus();
    const interval = setInterval(refreshStatus, 5000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;

    addUserMessage(text);
    setInput('');
    setIsStreaming(true);

    const { ipcRenderer } = window.require?.('electron') ?? {};
    if (ipcRenderer) {
      ipcRenderer.invoke(IPC_CHANNELS.ADMIRAL_SEND, text).catch((err: Error) => {
        setStreamError(err.message);
      });
    }
  }, [input, isStreaming, addUserMessage, setIsStreaming, setStreamError]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="h-full flex">
      {/* Chat panel */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-neutral-800 bg-neutral-900">
          <div className="flex items-center gap-2">
            <span className="text-yellow-400 text-lg">★</span>
            <h2 className="text-sm font-semibold text-neutral-200">Star Command</h2>
          </div>
          <button
            className="text-xs text-neutral-500 hover:text-neutral-300 px-2 py-1 rounded hover:bg-neutral-800"
            onClick={toggleStatusPanel}
          >
            {statusPanelOpen ? 'Hide Status' : 'Show Status'}
          </button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {messages.length === 0 && !streamBuffer && (
            <div className="flex flex-col items-center justify-center h-full text-neutral-600">
              <span className="text-4xl mb-3">★</span>
              <p className="text-sm">Welcome to Star Command</p>
              <p className="text-xs mt-1">
                Ask the Admiral to deploy agents, manage sectors, or check status.
              </p>
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          {streamBuffer && (
            <div className="flex justify-start">
              <div className="max-w-[80%] px-3 py-2 rounded-lg bg-neutral-800 text-neutral-100 text-sm whitespace-pre-wrap">
                {streamBuffer}
                <span className="inline-block w-1.5 h-4 bg-neutral-400 ml-0.5 animate-pulse" />
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-neutral-800 px-4 py-3 bg-neutral-900">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isStreaming ? 'Admiral is responding...' : 'Message the Admiral...'}
              disabled={isStreaming}
              rows={1}
              className="flex-1 resize-none bg-neutral-800 text-white text-sm rounded-lg px-3 py-2 border border-neutral-700 focus:border-blue-500 focus:outline-none placeholder:text-neutral-500 disabled:opacity-50 max-h-32 overflow-y-auto"
              style={{ minHeight: '36px' }}
            />
            <button
              onClick={handleSend}
              disabled={isStreaming || !input.trim()}
              className="px-3 py-2 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      </div>

      {/* Status panel */}
      <StatusPanel />
    </div>
  );
}
