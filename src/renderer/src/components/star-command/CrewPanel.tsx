import { useState, useCallback, useEffect } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import type { CrewStatus } from '../../store/star-command-store';

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-400',
  hailing: 'bg-yellow-400 animate-pulse',
  error: 'bg-red-500',
  complete: 'bg-blue-400',
  idle: 'bg-neutral-500',
  lost: 'bg-red-500 animate-pulse'
};

function StatusDot({ status }: { status: string }) {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_COLORS[status] ?? 'bg-neutral-500'}`}
    />
  );
}

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
      {title}
      {count !== undefined && <span className="ml-1 text-neutral-600">({count})</span>}
    </h3>
  );
}

function CrewCard({ crew, onRefresh }: { crew: CrewStatus; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false);
  const [recallConfirm, setRecallConfirm] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [observing, setObserving] = useState(false);
  const [messageText, setMessageText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleRecall = async () => {
    setError(null);
    try {
      await window.fleet.starbase.recallCrew(crew.id);
      setRecallConfirm(false);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to recall');
    }
  };

  const handleObserve = async () => {
    setObserving(true);
    setError(null);
    try {
      const result = await window.fleet.starbase.observeCrew(crew.id);
      setOutput(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to observe');
    }
    setObserving(false);
  };

  const handleMessage = async () => {
    if (!messageText.trim()) return;
    setSending(true);
    setError(null);
    try {
      await window.fleet.starbase.messageCrew(crew.id, messageText.trim());
      setMessageText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send message');
    }
    setSending(false);
  };

  return (
    <div className="bg-neutral-800 rounded-lg border border-neutral-700 overflow-hidden">
      <button
        className="w-full text-left px-3 py-2 flex items-center gap-2 hover:bg-neutral-750 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusDot status={crew.status} />
        <span className="text-sm text-neutral-200 font-mono flex-1 truncate">{crew.id}</span>
        <span className="text-[10px] font-mono text-neutral-500 uppercase flex-shrink-0">
          {crew.status}
        </span>
        <span className="text-xs text-neutral-600">{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-neutral-700 pt-2 space-y-3">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="text-neutral-500">Sector</label>
              <div className="text-neutral-300 font-mono">{crew.sector_id}</div>
            </div>
            {crew.pid && (
              <div>
                <label className="text-neutral-500">PID</label>
                <div className="text-neutral-300 font-mono">{crew.pid}</div>
              </div>
            )}
            {crew.worktree_branch && (
              <div>
                <label className="text-neutral-500">Branch</label>
                <div className="text-neutral-300 font-mono truncate">{crew.worktree_branch}</div>
              </div>
            )}
            <div>
              <label className="text-neutral-500">Deployed</label>
              <div className="text-neutral-300">{new Date(crew.created_at).toLocaleString()}</div>
            </div>
          </div>

          {crew.mission_summary && (
            <div className="text-xs">
              <label className="text-neutral-500 block mb-1">Mission</label>
              <div className="text-neutral-300 bg-neutral-900 rounded px-2 py-1">
                {crew.mission_summary}
              </div>
            </div>
          )}

          {/* Observe output */}
          {output !== null && (
            <div className="text-xs">
              <div className="flex items-center justify-between mb-1">
                <label className="text-neutral-500">Recent Output</label>
                <button
                  onClick={() => setOutput(null)}
                  className="text-neutral-600 hover:text-neutral-400 text-[10px]"
                >
                  ✕
                </button>
              </div>
              <div className="bg-neutral-900 rounded p-2 font-mono text-neutral-300 whitespace-pre-wrap max-h-40 overflow-y-auto text-[11px]">
                {output || '(no output)'}
              </div>
            </div>
          )}

          {/* Send message */}
          <div className="flex gap-2">
            <input
              type="text"
              value={messageText}
              onChange={(e) => setMessageText(e.target.value)}
              placeholder="Send message to crew..."
              className="flex-1 bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1 border border-neutral-600 focus:border-blue-500 focus:outline-none"
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleMessage();
              }}
            />
            <button
              onClick={() => { void handleMessage(); }}
              disabled={!messageText.trim() || sending}
              className="px-2 py-1 bg-blue-600 hover:bg-blue-500 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs rounded transition-colors"
            >
              {sending ? '...' : 'Send'}
            </button>
          </div>

          {error && <p className="text-xs text-red-400">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              onClick={() => { void handleObserve(); }}
              disabled={observing}
              className="text-xs text-neutral-400 hover:text-neutral-200 transition-colors"
            >
              {observing ? 'Loading...' : 'Observe'}
            </button>

            {recallConfirm ? (
              <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800/50 rounded px-2 py-1 ml-auto">
                <span className="text-[10px] text-red-300">Recall crew?</span>
                <button
                  onClick={() => { void handleRecall(); }}
                  className="text-[10px] px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setRecallConfirm(false)}
                  className="text-[10px] text-neutral-400 hover:text-neutral-200 transition-colors"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setRecallConfirm(true)}
                className="text-xs text-red-400 hover:text-red-300 transition-colors ml-auto"
              >
                Recall
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DeploySection({ onRefresh }: { onRefresh: () => void }) {
  const { sectors } = useStarCommandStore();
  const [sectorId, setSectorId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [summary, setSummary] = useState('');
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const handleDeploy = async () => {
    if (!sectorId || !prompt.trim()) return;
    setDeploying(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await window.fleet.starbase.deployCrew({
        sectorId,
        prompt: prompt.trim(),
        summary: summary.trim() || prompt.trim().slice(0, 80)
      });
      setSuccess(`Deployed ${result.crewId}`);
      setPrompt('');
      setSummary('');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to deploy');
    }
    setDeploying(false);
  };

  return (
    <div className="bg-neutral-800/50 rounded-lg border border-neutral-700 border-dashed p-3 space-y-2">
      <div className="text-xs text-neutral-500 font-semibold">Deploy Crew</div>

      <select
        value={sectorId}
        onChange={(e) => setSectorId(e.target.value)}
        className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
      >
        <option value="">Select sector...</option>
        {sectors.map((s) => (
          <option key={s.id} value={s.id}>
            {s.id} — {s.name}
          </option>
        ))}
      </select>

      <input
        type="text"
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Mission summary (optional)"
        className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none"
      />

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Mission prompt..."
        rows={4}
        className="w-full bg-neutral-900 text-neutral-300 text-xs rounded px-2 py-1.5 border border-neutral-600 focus:border-blue-500 focus:outline-none resize-y font-mono"
      />

      {error && <p className="text-xs text-red-400">{error}</p>}
      {success && <p className="text-xs text-green-400">{success}</p>}

      <button
        onClick={() => { void handleDeploy(); }}
        disabled={!sectorId || !prompt.trim() || deploying}
        className="w-full px-3 py-1.5 bg-teal-700 hover:bg-teal-600 disabled:bg-neutral-700 disabled:text-neutral-500 text-white text-xs font-medium rounded transition-colors"
      >
        {deploying ? 'Deploying...' : 'Deploy'}
      </button>
    </div>
  );
}

function MissionQueueSection() {
  const { missionQueue } = useStarCommandStore();

  const statusColor: Record<string, string> = {
    queued: 'text-yellow-400',
    active: 'text-green-400',
    done: 'text-neutral-500',
    failed: 'text-red-400',
    'failed-verification': 'text-red-400',
    reviewing: 'text-blue-400',
    approved: 'text-green-400',
    'changes-requested': 'text-yellow-400',
    escalated: 'text-red-400',
    'pending-review': 'text-blue-300'
  };

  return (
    <section>
      <SectionHeader title="Mission Queue" count={missionQueue.length} />
      <div className="space-y-1.5">
        {missionQueue.map((m) => (
          <div
            key={m.id}
            className="bg-neutral-800 rounded border border-neutral-700 px-3 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2 mb-0.5">
              <span className="font-mono text-neutral-500">#{m.id}</span>
              <span
                className={`font-mono uppercase text-[10px] ${statusColor[m.status] ?? 'text-neutral-400'}`}
              >
                {m.status}
              </span>
            </div>
            <p className="text-neutral-300 truncate">{m.summary}</p>
            <p className="text-neutral-500 text-[10px] mt-0.5">sector: {m.sector_id}</p>
          </div>
        ))}
        {missionQueue.length === 0 && (
          <p className="text-xs text-neutral-600">No missions in queue</p>
        )}
      </div>
    </section>
  );
}

export function CrewPanel() {
  const { crewList, setCrewList, setMissionQueue } = useStarCommandStore();

  const refresh = useCallback(async () => {
    try {
      const [crew, missions] = await Promise.all([
        window.fleet.starbase.listCrew(),
        window.fleet.starbase.listMissions()
      ]);
      setCrewList(crew);
      setMissionQueue(missions);
    } catch {
      // ignore
    }
  }, [setCrewList, setMissionQueue]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div className="text-sm text-neutral-300 font-semibold">Crew &amp; Missions</div>

      {/* Crew list */}
      <section>
        <SectionHeader title="Active Crew" count={crewList.length} />
        <div className="space-y-2 mb-3">
          {crewList.map((c) => (
            <CrewCard key={c.id} crew={c} onRefresh={() => { void refresh(); }} />
          ))}
          {crewList.length === 0 && <p className="text-xs text-neutral-600">No crew deployed</p>}
        </div>
      </section>

      {/* Deploy section */}
      <DeploySection onRefresh={() => { void refresh(); }} />

      {/* Mission queue */}
      <MissionQueueSection />
    </div>
  );
}
