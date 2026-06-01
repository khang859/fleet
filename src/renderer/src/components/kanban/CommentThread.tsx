import { useState } from 'react';
import type { TaskComment } from '../../../../shared/kanban-types';
import { relativeTime } from './kanban-utils';

type Props = {
  comments: TaskComment[];
  onPost: (body: string) => void;
  /** Hide the composer (history only) — the blocked-card reply box composes instead. */
  readOnly?: boolean;
};

export function CommentThread({ comments, onPost, readOnly = false }: Props): React.JSX.Element {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex flex-col gap-2">
      {comments.length === 0 && <p className="text-xs text-neutral-500">No comments yet.</p>}
      {comments.map((c) => (
        <div key={c.id} className="rounded border border-neutral-800 bg-neutral-900 p-2 text-xs">
          <div className="mb-1 flex items-center gap-2 text-[10px] text-neutral-500">
            <span className="font-medium text-neutral-300">{c.author}</span>
            <span>{relativeTime(c.createdAt)}</span>
          </div>
          <p className="whitespace-pre-wrap text-neutral-200">{c.body}</p>
        </div>
      ))}
      {readOnly ? null : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              const body = draft.trim();
              if (body) {
                onPost(body);
                setDraft('');
              }
            }
          }}
          placeholder="Comment… (Enter to post, Shift+Enter for newline)"
          rows={2}
          className="rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
        />
      )}
    </div>
  );
}
