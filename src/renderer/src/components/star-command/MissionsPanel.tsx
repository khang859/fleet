import { useState, useCallback, useEffect } from 'react';
import { useStarCommandStore } from '../../store/star-command-store';
import type { MissionInfo } from '../../store/star-command-store';

function SectionHeader({ title, count }: { title: string; count?: number }): React.JSX.Element {
  return (
    <h3 className="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-3">
      {title}
      {count !== undefined && <span className="ml-1 text-neutral-600">({count})</span>}
    </h3>
  );
}

const STATUS_DOT: Record<string, string> = {
  active: 'bg-green-400',
  queued: 'bg-yellow-400',
  completed: 'bg-teal-400',
  done: 'bg-teal-400',
  failed: 'bg-red-500',
  aborted: 'bg-red-500'
};

function StatusDot({ status }: { status: string }): React.JSX.Element {
  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${STATUS_DOT[status] ?? 'bg-neutral-500'}`}
    />
  );
}

function MissionCard({ mission }: { mission: MissionInfo }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);

  const formatDate = (dt: string | null): string => (dt ? new Date(dt).toLocaleString() : '—');

  return (
    <div className="bg-neutral-800 rounded-lg border border-neutral-700 overflow-hidden">
      <button
        className="w-full text-left px-3 py-2 flex items-start gap-2 hover:bg-neutral-750 transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <StatusDot status={mission.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-mono text-neutral-500">#{mission.id}</span>
            {mission.priority > 0 && (
              <span className="text-[10px] font-mono text-orange-400">P{mission.priority}</span>
            )}
            <span className="text-[10px] font-mono text-neutral-500 uppercase ml-auto">
              {mission.sector_id}
            </span>
          </div>
          <p className="text-xs text-neutral-200 mt-0.5 truncate">{mission.summary}</p>
          {mission.crew_id && (
            <p className="text-[10px] text-neutral-500 mt-0.5 font-mono truncate">
              crew: {mission.crew_id}
            </p>
          )}
        </div>
        <span className="text-xs text-neutral-600 flex-shrink-0 mt-0.5">
          {expanded ? '▲' : '▼'}
        </span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 border-t border-neutral-700 pt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div>
              <label className="text-neutral-500">Sector</label>
              <div className="text-neutral-300 font-mono">{mission.sector_id}</div>
            </div>
            {mission.crew_id && (
              <div>
                <label className="text-neutral-500">Crew</label>
                <div className="text-neutral-300 font-mono truncate">{mission.crew_id}</div>
              </div>
            )}
            <div>
              <label className="text-neutral-500">Created</label>
              <div className="text-neutral-300">{formatDate(mission.created_at)}</div>
            </div>
            {mission.started_at && (
              <div>
                <label className="text-neutral-500">Started</label>
                <div className="text-neutral-300">{formatDate(mission.started_at)}</div>
              </div>
            )}
            {mission.completed_at && (
              <div>
                <label className="text-neutral-500">Completed</label>
                <div className="text-neutral-300">{formatDate(mission.completed_at)}</div>
              </div>
            )}
            {mission.depends_on_mission_id !== null && (
              <div>
                <label className="text-neutral-500">Depends on</label>
                <div className="text-neutral-300 font-mono">#{mission.depends_on_mission_id}</div>
              </div>
            )}
          </div>

          <div className="text-xs">
            <label className="text-neutral-500 block mb-1">Prompt</label>
            <div className="bg-neutral-900 rounded p-2 text-neutral-300 whitespace-pre-wrap break-words max-h-40 overflow-y-auto font-mono text-[11px]">
              {mission.prompt}
            </div>
          </div>

          {mission.acceptance_criteria && (
            <div className="text-xs">
              <label className="text-neutral-500 block mb-1">Acceptance Criteria</label>
              <div className="bg-neutral-900 rounded p-2 text-neutral-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto text-[11px]">
                {mission.acceptance_criteria}
              </div>
            </div>
          )}

          {mission.result && (
            <div className="text-xs">
              <label className="text-neutral-500 block mb-1">Result</label>
              <div className="bg-neutral-900 rounded p-2 text-neutral-300 whitespace-pre-wrap break-words max-h-32 overflow-y-auto text-[11px]">
                {mission.result}
              </div>
            </div>
          )}

          {mission.review_verdict && (
            <div className="text-xs">
              <label className="text-neutral-500 block mb-1">Review</label>
              <div className="flex items-center gap-2">
                <span
                  className={`font-mono text-[10px] uppercase ${mission.review_verdict === 'approved' ? 'text-green-400' : 'text-red-400'}`}
                >
                  {mission.review_verdict}
                </span>
                {mission.review_notes && (
                  <span className="text-neutral-400 text-[11px]">{mission.review_notes}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function MissionsPanel(): React.JSX.Element {
  const { missionQueue, setMissionQueue } = useStarCommandStore();

  const refresh = useCallback(async () => {
    try {
      const missions = await window.fleet.starbase.listMissions();
      setMissionQueue(missions);
    } catch {
      // ignore
    }
  }, [setMissionQueue]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const missions = missionQueue;

  const active = missions.filter((m) => m.status === 'active');
  const queued = missions.filter((m) => m.status === 'queued');
  const completed = missions.filter((m) => m.status === 'completed' || m.status === 'done');
  const failed = missions.filter((m) => m.status === 'failed' || m.status === 'aborted');

  return (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-6">
      <div className="text-sm text-neutral-300 font-semibold">Missions</div>

      {active.length > 0 && (
        <section>
          <SectionHeader title="Active" count={active.length} />
          <div className="space-y-2">
            {active.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}

      {queued.length > 0 && (
        <section>
          <SectionHeader title="Queued" count={queued.length} />
          <div className="space-y-2">
            {queued.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}

      {completed.length > 0 && (
        <section>
          <SectionHeader title="Completed" count={completed.length} />
          <div className="space-y-2">
            {completed.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}

      {failed.length > 0 && (
        <section>
          <SectionHeader title="Failed" count={failed.length} />
          <div className="space-y-2">
            {failed.map((m) => (
              <MissionCard key={m.id} mission={m} />
            ))}
          </div>
        </section>
      )}

      {missions.length === 0 && (
        <p className="text-xs text-neutral-600 text-center py-8">No missions</p>
      )}
    </div>
  );
}
