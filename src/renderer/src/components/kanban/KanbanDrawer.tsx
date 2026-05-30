import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { X } from 'lucide-react';
import { useKanbanStore } from '../../store/kanban-store';
import { CommentThread } from './CommentThread';
import { relativeTime, formatDuration } from './kanban-utils';
import type { TaskStatus } from '../../../../shared/kanban-types';

const ACTIONS: Array<{ status: TaskStatus; label: string }> = [
  { status: 'ready', label: '→ Ready' },
  { status: 'blocked', label: 'Block' },
  { status: 'todo', label: 'Unblock' },
  { status: 'done', label: 'Complete' },
  { status: 'archived', label: 'Archive' }
];

export function KanbanDrawer(): React.JSX.Element | null {
  const { detail, closeTask, updateTask, setStatus, addComment, addLink, removeLink } =
    useKanbanStore();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [assignee, setAssignee] = useState('');
  const [priority, setPriority] = useState(0);
  const [tenant, setTenant] = useState('');
  const [linkId, setLinkId] = useState('');

  useEffect(() => {
    if (detail) {
      setTitle(detail.task.title);
      setBody(detail.task.body);
      setAssignee(detail.task.assignee ?? '');
      setPriority(detail.task.priority);
      setTenant(detail.task.tenant ?? '');
    }
  }, [detail]);

  if (!detail) return null;
  const t = detail.task;
  const running = t.status === 'running';

  function save(): void {
    void updateTask(t.id, {
      title,
      body,
      assignee: assignee.trim() === '' ? null : assignee.trim(),
      priority,
      tenant: tenant.trim() === '' ? null : tenant.trim()
    });
  }

  return (
    <div className="fixed right-0 top-0 z-40 flex h-full w-[420px] flex-col border-l border-neutral-800 bg-neutral-900 shadow-2xl">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2">
        <span className="font-mono text-xs text-neutral-500">
          {t.id} · {t.status}
        </span>
        <button onClick={closeTask} className="rounded p-1 text-neutral-400 hover:bg-neutral-800">
          <X size={14} />
        </button>
      </div>

      <div className="flex-1 space-y-4 overflow-y-auto p-3 text-xs">
        {/* Editable fields */}
        <div className="space-y-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={save}
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-sm font-medium outline-none focus:border-blue-500"
          />
          <div className="flex gap-2">
            <input
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              onBlur={save}
              placeholder="assignee"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
            <input
              type="number"
              value={priority}
              onChange={(e) => setPriority(Number(e.target.value))}
              onBlur={save}
              title="priority"
              className="w-16 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
            <input
              value={tenant}
              onChange={(e) => setTenant(e.target.value)}
              onBlur={save}
              placeholder="tenant"
              className="w-24 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
            />
          </div>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={save}
            rows={5}
            placeholder="Body (markdown)…"
            className="w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 outline-none focus:border-blue-500"
          />
        </div>

        {/* Status actions */}
        <div className="flex flex-wrap gap-1.5">
          {ACTIONS.map((a) => (
            <button
              key={a.label}
              disabled={running}
              onClick={() => void setStatus(t.id, a.status)}
              className="rounded border border-neutral-700 px-2 py-1 text-neutral-300 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {a.label}
            </button>
          ))}
        </div>
        {running && (
          <p className="text-[10px] text-amber-400">
            Running tasks are dispatcher-controlled; status actions are disabled.
          </p>
        )}

        {/* Result / body preview */}
        {t.result && (
          <section>
            <h3 className="mb-1 font-semibold text-neutral-400">Result</h3>
            <div className="markdown-preview rounded border border-neutral-800 bg-neutral-950 p-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                {t.result}
              </ReactMarkdown>
            </div>
          </section>
        )}

        {/* Dependencies */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Dependencies</h3>
          {detail.parents.length > 0 && (
            <div className="mb-1">
              <span className="text-[10px] text-neutral-500">Parents: </span>
              {detail.parents.map((p) => (
                <span
                  key={p.id}
                  className="mr-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-1 font-mono text-[10px]"
                >
                  {p.id}
                  <button
                    onClick={() => void removeLink(p.id, t.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {detail.children.length > 0 && (
            <div className="mb-1">
              <span className="text-[10px] text-neutral-500">Children: </span>
              {detail.children.map((c) => (
                <span
                  key={c.id}
                  className="mr-1 inline-flex items-center gap-1 rounded bg-neutral-800 px-1 font-mono text-[10px]"
                >
                  {c.id} ({c.status})
                  <button
                    onClick={() => void removeLink(t.id, c.id)}
                    className="text-neutral-500 hover:text-red-400"
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="mt-1 flex gap-1">
            <input
              value={linkId}
              onChange={(e) => setLinkId(e.target.value)}
              placeholder="child task id"
              className="flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono outline-none focus:border-blue-500"
            />
            <button
              onClick={() => {
                const id = linkId.trim();
                if (id && id !== t.id) {
                  void addLink(t.id, id);
                  setLinkId('');
                }
              }}
              className="rounded border border-neutral-700 px-2 py-1 hover:bg-neutral-800"
            >
              Add child
            </button>
          </div>
        </section>

        {/* Run history */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Runs</h3>
          {detail.runs.length === 0 && <p className="text-neutral-500">No runs yet.</p>}
          {detail.runs.map((r) => (
            <div key={r.id} className="mb-1 rounded border border-neutral-800 bg-neutral-950 p-2">
              <div className="flex items-center justify-between text-[10px] text-neutral-500">
                <span>
                  {r.profile ?? 'no-profile'} · {r.outcome ?? r.status}
                </span>
                <span>{formatDuration(r.startedAt, r.endedAt)}</span>
              </div>
              {r.summary && <p className="mt-1 text-neutral-300">{r.summary}</p>}
              {r.error && <p className="mt-1 text-red-400">{r.error}</p>}
            </div>
          ))}
        </section>

        {/* Comments */}
        <section>
          <h3 className="mb-1 font-semibold text-neutral-400">Comments</h3>
          <CommentThread comments={detail.comments} onPost={(b) => void addComment(t.id, b)} />
        </section>

        <p className="text-[10px] text-neutral-600">
          Created {relativeTime(t.createdAt)} · Updated {relativeTime(t.updatedAt)}
        </p>
      </div>
    </div>
  );
}
