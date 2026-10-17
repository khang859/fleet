import { createContext, useContext } from 'react';

/**
 * What a transcript drawn inside an Admiral pane knows that a plain Agent
 * pane's does not: which repository's questions its cards answer, and how a
 * line about a job takes the client to that job's tab.
 *
 * A context rather than props, because the rows that need it are deep inside
 * memoized messages, and nothing between the pane and them has any use for it.
 */
export type AdmiralThreadContextValue = {
  repoId: string;
  /** The job whose conversation this is, or null for the lobby. */
  jobId: number | null;
  onOpenJob: (jobId: number) => void;
};

export const AdmiralThreadContext = createContext<AdmiralThreadContextValue | null>(null);

/** The Admiral pane around this transcript, or null in a plain Agent pane. */
export function useAdmiralThread(): AdmiralThreadContextValue | null {
  return useContext(AdmiralThreadContext);
}
