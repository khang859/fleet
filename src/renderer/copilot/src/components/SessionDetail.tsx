import { useCopilotStore } from '../store/copilot-store';

export function SessionDetail(): React.JSX.Element | null {
  const selectedSessionId = useCopilotStore((s) => s.selectedSessionId);
  const sessions = useCopilotStore((s) => s.sessions);
  const backToList = useCopilotStore((s) => s.backToList);
  const respondPermission = useCopilotStore((s) => s.respondPermission);

  const session = sessions.find((s) => s.sessionId === selectedSessionId);

  if (!session) {
    return (
      <div className="flex flex-col h-full bg-neutral-900 rounded-lg border border-neutral-700">
        <div className="flex items-center px-3 py-2 border-b border-neutral-700">
          <button onClick={backToList} className="text-xs text-neutral-400 hover:text-neutral-200">
            ← Back
          </button>
        </div>
        <div className="flex-1 flex items-center justify-center text-neutral-500 text-xs">
          Session not found
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-neutral-900 rounded-lg border border-neutral-700 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-neutral-700">
        <button onClick={backToList} className="text-xs text-neutral-400 hover:text-neutral-200">
          ←
        </button>
        <span className="text-xs font-medium text-neutral-200 truncate">
          {session.projectName}
        </span>
      </div>

      <div className="px-3 py-2 border-b border-neutral-800 text-[10px] text-neutral-500">
        <div>CWD: {session.cwd}</div>
        {session.pid && <div>PID: {session.pid}</div>}
        <div>Phase: {session.phase}</div>
      </div>

      {session.pendingPermissions.length > 0 && (
        <div className="px-3 py-2 border-b border-neutral-800">
          <div className="text-[10px] font-medium text-amber-400 mb-1">
            Pending Permissions
          </div>
          {session.pendingPermissions.map((perm) => (
            <div key={perm.toolUseId} className="mb-2 p-2 bg-neutral-800/50 rounded border border-amber-500/20">
              <div className="text-xs text-neutral-200 font-medium">
                {perm.tool.toolName}
              </div>
              {Object.keys(perm.tool.toolInput).length > 0 && (
                <pre className="mt-1 text-[10px] text-neutral-400 overflow-x-auto max-h-24 overflow-y-auto">
                  {JSON.stringify(perm.tool.toolInput, null, 2)}
                </pre>
              )}
              <div className="flex gap-1 mt-2">
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'allow')}
                  className="px-2 py-1 text-[10px] bg-green-600/30 text-green-400 rounded hover:bg-green-600/50"
                >
                  Allow
                </button>
                <button
                  onClick={() => respondPermission(perm.toolUseId, 'deny')}
                  className="px-2 py-1 text-[10px] bg-red-600/30 text-red-400 rounded hover:bg-red-600/50"
                >
                  Deny
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        <div className="text-[10px] text-neutral-500 text-center mt-4">
          Chat history will appear here
        </div>
      </div>
    </div>
  );
}
