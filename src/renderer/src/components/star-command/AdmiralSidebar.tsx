import { useStarCommandStore } from '../../store/star-command-store';

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

function StatusDot({ color }: { color: string }) {
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />;
}

export function AdmiralSidebar({
  avatarVariant,
  onMemoClick
}: {
  avatarVariant: string;
  onMemoClick?: () => void;
}) {
  const { crewList, sectors, unreadCount, admiralStatus, admiralStatusText, firstOfficerStatus } =
    useStarCommandStore();

  const activeCrew = crewList.filter((c) => c.status === 'active').length;
  const errorCrew = crewList.filter((c) => c.status === 'error' || c.status === 'lost').length;
  const totalCrew = crewList.length;

  const admiralSrc = ADMIRAL_IMAGES[avatarVariant] ?? ADMIRAL_IMAGES.default;
  const foSrc = FO_IMAGES[firstOfficerStatus.status] ?? FO_IMAGES.default;

  return (
    <div className="w-[260px] flex-shrink-0 bg-neutral-900 border-l border-neutral-800 flex flex-col overflow-y-auto scrollbar-sc">
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

        {/* Crew list */}
        {crewList.length > 0 && (
          <div>
            <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-widest mb-2">
              Crew
            </h3>
            <div className="space-y-1">
              {crewList.map((crew) => (
                <div key={crew.id} className="flex items-center gap-2 py-0.5">
                  <StatusDot color={STATUS_COLORS[crew.status] ?? 'bg-neutral-500'} />
                  <span className="text-xs text-neutral-300 truncate flex-1">{crew.id}</span>
                  <span className="text-[10px] font-mono text-neutral-600 uppercase">
                    {crew.status}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
