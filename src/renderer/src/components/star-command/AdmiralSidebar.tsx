import { useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import { useStarCommandStore } from '../../store/star-command-store';
import type { CrewStatus, SectorInfo } from '../../store/star-command-store';

import admiralDefault from '../../assets/admiral-default.png';
import admiralSpeaking from '../../assets/admiral-speaking.png';
import admiralThinking from '../../assets/admiral-thinking.png';
import admiralAlert from '../../assets/admiral-alert.png';
import admiralStandby from '../../assets/admiral-standby.png';

import foDefault from '../../assets/first-officer-default.png';
import foWorking from '../../assets/first-officer-working.png';
import foEscalation from '../../assets/first-officer-escalation.png';
import foIdle from '../../assets/first-officer-idle.png';

const FO_IMAGES: Record<string, string> = {
  idle: foIdle,
  working: foWorking,
  memo: foEscalation,
  default: foDefault
};

const ADMIRAL_IMAGES: Record<string, string> = {
  default: admiralDefault,
  speaking: admiralSpeaking,
  thinking: admiralThinking,
  alert: admiralAlert,
  standby: admiralStandby
};

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-400',
  hailing: 'bg-yellow-400 animate-pulse',
  error: 'bg-red-500',
  complete: 'bg-blue-400',
  idle: 'bg-neutral-500',
  lost: 'bg-red-500 animate-pulse'
};

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (isNaN(date.getTime())) return '';
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} min ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hr ago`;
  return `${Math.floor(diffHr / 24)} days ago`;
}

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  hailing: 'Hailing',
  error: 'Error',
  complete: 'Complete',
  idle: 'Idle',
  lost: 'Lost'
};

const SIDEBAR_ACTIVE_STATUSES = new Set(['active', 'hailing', 'error', 'lost', 'idle']);

function StatusDot({ color }: { color: string }): React.JSX.Element {
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />;
}

function CrewPopover({
  crew,
  sector,
  onClose
}: {
  crew: CrewStatus;
  sector: SectorInfo | undefined;
  onClose: () => void;
}): React.JSX.Element {
  const { setCrewList } = useStarCommandStore();
  const [observing, setObserving] = useState(false);
  const [output, setOutput] = useState<string | null>(null);
  const [observeError, setObserveError] = useState<string | null>(null);
  const [recallConfirm, setRecallConfirm] = useState(false);
  const [recalling, setRecalling] = useState(false);
  const [recallError, setRecallError] = useState<string | null>(null);

  const handleObserve = async (): Promise<void> => {
    setObserving(true);
    setObserveError(null);
    setOutput(null);
    try {
      const result = await window.fleet.starbase.observeCrew(crew.id);
      setOutput(result);
    } catch (err) {
      setObserveError(err instanceof Error ? err.message : 'Failed to observe');
    } finally {
      setObserving(false);
    }
  };

  const handleRecall = async (): Promise<void> => {
    setRecalling(true);
    setRecallError(null);
    try {
      await window.fleet.starbase.recallCrew(crew.id);
      const updated = await window.fleet.starbase.listCrew();
      setCrewList(updated);
      onClose();
    } catch (err) {
      setRecallError(err instanceof Error ? err.message : 'Failed to recall');
    } finally {
      setRecalling(false);
    }
  };

  const statusDotClass = STATUS_COLORS[crew.status] ?? 'bg-neutral-500';
  const label = crew.mission_summary?.trim() || crew.id;
  const deployedAt = new Date(crew.created_at).toLocaleString();
  const lastSeen = crew.last_lifesign ? relativeTime(crew.last_lifesign) : null;
  const sectorName = sector?.name ?? crew.sector_id;

  return (
    <div className="w-72 bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl text-xs">
      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-neutral-800">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="flex items-center gap-1.5">
            <StatusDot color={statusDotClass} />
            <span className="font-mono text-neutral-400 uppercase text-[10px]">
              {STATUS_LABELS[crew.status] ?? crew.status}
            </span>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-neutral-600 hover:text-neutral-400 transition-colors leading-none"
          >
            ✕
          </button>
        </div>
        <p className="text-neutral-200 text-sm leading-snug">{label}</p>
        <p className="text-neutral-600 font-mono text-[10px] mt-0.5 truncate">{crew.id}</p>
      </div>

      {/* Metadata */}
      <div className="px-3 py-2 space-y-1.5 border-b border-neutral-800">
        <div className="flex justify-between gap-4">
          <span className="text-neutral-500">Sector</span>
          <span className="text-neutral-300 font-mono truncate">{sectorName}</span>
        </div>
        {crew.worktree_branch && (
          <div className="flex justify-between gap-4">
            <span className="text-neutral-500">Branch</span>
            <span className="text-neutral-300 font-mono truncate">{crew.worktree_branch}</span>
          </div>
        )}
        <div className="flex justify-between gap-4">
          <span className="text-neutral-500">Deployed</span>
          <span className="text-neutral-300">{deployedAt}</span>
        </div>
        {lastSeen && (
          <div className="flex justify-between gap-4">
            <span className="text-neutral-500">Last seen</span>
            <span className="text-neutral-300">{lastSeen}</span>
          </div>
        )}
        {crew.token_budget != null && (
          <div>
            <span className="text-neutral-500">Tokens</span>
            <div
              className="w-full bg-neutral-700 rounded-full h-1.5 mt-1"
              role="progressbar"
              aria-valuemin={0}
              aria-valuenow={crew.tokens_used ?? 0}
              aria-valuemax={crew.token_budget}
            >
              <div
                className="bg-teal-500 h-1.5 rounded-full"
                style={{
                  width: `${Math.min(100, ((crew.tokens_used ?? 0) / crew.token_budget) * 100)}%`
                }}
              />
            </div>
            <span className="text-[10px] font-mono text-neutral-500">
              {crew.tokens_used ?? 0} / {crew.token_budget}
            </span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="px-3 py-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <button
            onClick={() => { void handleObserve(); }}
            disabled={observing}
            className="text-neutral-400 hover:text-neutral-200 transition-colors disabled:opacity-50"
          >
            {observing ? 'Loading...' : 'Observe'}
          </button>

          {recallConfirm ? (
            <div className="flex items-center gap-1.5 bg-red-950/60 border border-red-800/50 rounded px-2 py-1">
              <span className="text-[10px] text-red-300">Recall?</span>
              <button
                onClick={() => { void handleRecall(); }}
                disabled={recalling}
                className="text-[10px] px-1.5 py-0.5 bg-red-700 hover:bg-red-600 text-white rounded transition-colors"
              >
                {recalling ? '...' : 'Confirm'}
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
              className="text-red-400 hover:text-red-300 transition-colors"
            >
              Recall ▸
            </button>
          )}
        </div>

        {output !== null && (
          <pre className="bg-neutral-950 rounded p-2 font-mono text-neutral-300 text-[10px] whitespace-pre-wrap max-h-32 overflow-y-auto">
            {output || '(no output)'}
          </pre>
        )}
        {observeError && <p className="text-red-400">{observeError}</p>}
        {recallError && <p className="text-red-400">{recallError}</p>}
      </div>
    </div>
  );
}

export function AdmiralSidebar({
  avatarVariant,
  onMemoClick
}: {
  avatarVariant: string;
  onMemoClick?: () => void;
}): React.JSX.Element {
  const { crewList, sectors, unreadCount, admiralStatus, admiralStatusText, firstOfficerStatus } =
    useStarCommandStore();

  const [openCrewId, setOpenCrewId] = useState<string | null>(null);

  const activeSidebarCrew = crewList.filter((c) => SIDEBAR_ACTIVE_STATUSES.has(c.status));
  const bySector = new Map<string, CrewStatus[]>();
  for (const crew of activeSidebarCrew) {
    const list = bySector.get(crew.sector_id) ?? [];
    list.push(crew);
    bySector.set(crew.sector_id, list);
  }

  const activeCrew = crewList.filter((c) => c.status === 'active').length;
  const errorCrew = crewList.filter((c) => c.status === 'error' || c.status === 'lost').length;
  const totalCrew = crewList.length;

  const admiralSrc = ADMIRAL_IMAGES[avatarVariant] ?? ADMIRAL_IMAGES.default;
  const foSrc = FO_IMAGES[firstOfficerStatus.status] ?? FO_IMAGES.default;

  return (
    <div
      className="w-[260px] flex-shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col overflow-y-auto scrollbar-sc"
      onScroll={() => setOpenCrewId(null)}
    >
      {/* Admiral avatar — full-res 512x512 source image */}
      <div className="flex flex-col items-center pt-6 pb-4 border-b border-neutral-800">
        <img
          src={admiralSrc}
          alt={`Admiral — ${avatarVariant}`}
          width={192}
          height={192}
          className="rounded"
          style={{ imageRendering: 'pixelated' }}
        />
        <span className="text-xs font-mono text-teal-400 uppercase tracking-widest mt-2">
          Admiral
        </span>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            className={`w-2 h-2 rounded-full ${
              admiralStatus === 'running'
                ? 'bg-green-400'
                : admiralStatus === 'starting'
                  ? 'bg-yellow-400 animate-pulse'
                  : 'bg-red-500'
            }`}
          />
          <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
            {admiralStatus === 'running' ? admiralStatusText : admiralStatus}
          </span>
        </div>
      </div>

      {/* First Officer */}
      <div className="flex flex-col items-center pt-4 pb-4 border-b border-neutral-800">
        <img
          src={foSrc}
          alt="First Officer"
          width={128}
          height={128}
          className="rounded"
          style={{ imageRendering: 'pixelated' as const }}
        />
        <span className="text-xs font-mono text-teal-400 uppercase tracking-widest mt-2">
          First Officer
        </span>
        <div className="flex items-center gap-1.5 mt-1">
          <span
            className={`w-2 h-2 rounded-full ${
              firstOfficerStatus.status === 'working'
                ? 'bg-teal-400 animate-pulse'
                : firstOfficerStatus.status === 'memo'
                  ? 'bg-yellow-400'
                  : 'bg-green-400'
            }`}
          />
          <span className="text-[10px] font-mono text-neutral-500 uppercase tracking-wider">
            {firstOfficerStatus.statusText}
          </span>
        </div>
        {firstOfficerStatus.unreadMemos > 0 && (
          <button
            onClick={onMemoClick}
            className="mt-2 flex items-center gap-1.5 px-2 py-1 rounded bg-neutral-800 hover:bg-neutral-700 transition-colors"
          >
            <span className="bg-amber-600 text-white text-[10px] font-mono font-bold rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0">
              {firstOfficerStatus.unreadMemos > 9 ? '9+' : firstOfficerStatus.unreadMemos}
            </span>
            <span className="text-xs text-neutral-300">
              {firstOfficerStatus.unreadMemos === 1 ? 'memo' : 'memos'}
            </span>
          </button>
        )}
      </div>

      {/* Status sections */}
      <div className="px-4 py-4 space-y-4">
        {/* Fleet */}
        <div>
          <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
            Fleet
          </h3>
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-400">Active crew</span>
              <span className="text-xs font-mono text-neutral-200">
                {activeCrew}/{totalCrew}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-neutral-400">Sectors</span>
              <span className="text-xs font-mono text-neutral-200">{sectors.length}</span>
            </div>
            {errorCrew > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-xs text-red-400">Errors</span>
                <span className="text-xs font-mono text-red-400">{errorCrew}</span>
              </div>
            )}
          </div>
        </div>

        {/* Sentinel */}
        <div>
          <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
            Sentinel
          </h3>
          <div className="flex items-center gap-2">
            <StatusDot color={errorCrew > 0 ? 'bg-red-500' : 'bg-green-400'} />
            <span className="text-xs text-neutral-300">
              {errorCrew > 0 ? `${errorCrew} alert${errorCrew > 1 ? 's' : ''}` : 'All clear'}
            </span>
          </div>
        </div>

        {/* Inbox */}
        <div>
          <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
            Inbox
          </h3>
          <div className="flex items-center gap-2">
            {unreadCount > 0 ? (
              <>
                <span className="bg-teal-600 text-white text-[10px] font-mono font-bold rounded-full w-5 h-5 flex items-center justify-center flex-shrink-0">
                  {unreadCount > 9 ? '9+' : unreadCount}
                </span>
                <span className="text-xs text-neutral-300">unread</span>
              </>
            ) : (
              <>
                <StatusDot color="bg-neutral-600" />
                <span className="text-xs text-neutral-500">No new messages</span>
              </>
            )}
          </div>
        </div>

        {/* Crew list — sector-grouped with popover detail */}
        {activeSidebarCrew.length > 0 && (
          <div>
            <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
              Crew
            </h3>
            {Array.from(bySector.entries()).map(([sectorId, sectorCrew]) => {
              const sector = sectors.find((s) => s.id === sectorId);
              const sectorLabel = sector?.name ?? sectorId;
              return (
                <div key={sectorId} className="mb-2">
                  <div className="text-[9px] font-mono text-neutral-600 uppercase tracking-widest mb-1 pl-0.5">
                    {sectorLabel}
                  </div>
                  {sectorCrew.map((crew) => (
                    <Popover.Root
                      key={crew.id}
                      open={openCrewId === crew.id}
                      onOpenChange={(open) => setOpenCrewId(open ? crew.id : null)}
                    >
                      <Popover.Trigger className="w-full flex items-center gap-2 py-0.5 pl-2 rounded text-left cursor-pointer hover:bg-neutral-800 transition-colors">
                        <StatusDot color={STATUS_COLORS[crew.status] ?? 'bg-neutral-500'} />
                        <span className="text-xs text-neutral-300 truncate flex-1">
                          {crew.mission_summary?.trim() || crew.id}
                        </span>
                        <span className="text-[10px] font-mono text-neutral-600 uppercase flex-shrink-0">
                          {crew.status}
                        </span>
                      </Popover.Trigger>
                      <Popover.Portal>
                        <Popover.Content
                          side="left"
                          sideOffset={8}
                          className="z-50"
                        >
                          <CrewPopover
                            crew={crew}
                            sector={sector}
                            onClose={() => setOpenCrewId(null)}
                          />
                        </Popover.Content>
                      </Popover.Portal>
                    </Popover.Root>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
