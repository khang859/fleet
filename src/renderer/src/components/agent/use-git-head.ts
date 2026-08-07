import { useEffect, useState } from 'react';
import type { AgentGitHead } from '../../../../shared/agent-git';

/**
 * The branch the pane's folder is on, kept current by main.
 *
 * Deliberately local state rather than anything on the store's `PaneThread`.
 * That record is written to the session log and replayed when a pane reopens,
 * and a branch is emphatically not part of a conversation: replaying a session
 * from last week must not resurrect the branch it happened to start on.
 *
 * `null` covers both "not a repo" and "not read yet", which the caption wants
 * to render identically anyway - there is no flash of an error state to avoid.
 */
export function useGitHead(paneId: string, cwd: string): AgentGitHead | null {
  const [head, setHead] = useState<AgentGitHead | null>(null);

  useEffect(() => {
    setHead(null);
    const off = window.fleet.agent.onGitHead((event) => {
      if (event.paneId !== paneId) return;
      setHead(event.head);
    });
    // Registering answers immediately, so this is also the first read.
    window.fleet.agent.watchGit(paneId, cwd);
    return () => {
      off();
      window.fleet.agent.unwatchGit(paneId);
    };
  }, [paneId, cwd]);

  return head;
}
