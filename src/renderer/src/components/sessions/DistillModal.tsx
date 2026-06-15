import { useCallback, useEffect, useRef, useState } from 'react';
import { Overlay } from '../Overlay';
import type { SessionSummary } from '../../../../shared/sessions';
import type { DistillResult, Learning, TagCount } from '../../../../shared/learnings';

type Phase = 'loading' | 'ready' | 'nothing' | 'error';

/** Parse the comma-separated tags field into a clean list. */
function parseTags(raw: string): string[] {
  return raw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

/** Rewrite suggested tags to the existing vocabulary's casing, de-duped. */
function normalizeTags(tags: string[], vocab: TagCount[]): string[] {
  const byLower = new Map(vocab.map((v) => [v.tag.toLowerCase(), v.tag]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    const canon = byLower.get(t.toLowerCase()) ?? t;
    const key = canon.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(canon);
    }
  }
  return out;
}

/** Case-insensitive union of two tag lists, preserving order. */
function unionTags(a: string[], b: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...a, ...b]) {
    const key = t.toLowerCase();
    if (t && !seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * Distill a finished session (or one Rune branch) into a draft learning via a
 * headless one-shot run on Fleet's flagship agent, then let the user edit, dedup
 * against existing learnings, and save it into the cross-project learnings store.
 */
export function DistillModal({
  open,
  session,
  nodeId,
  onClose,
  onSaved
}: {
  open: boolean;
  session: SessionSummary | null;
  nodeId?: string;
  onClose: () => void;
  onSaved?: () => void;
}): React.JSX.Element | null {
  // Snapshot the session/node so they stay stable while the modal is open.
  const [shown, setShown] = useState<SessionSummary | null>(session);
  const [shownNode, setShownNode] = useState<string | undefined>(nodeId);
  const [phase, setPhase] = useState<Phase>('loading');
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tags, setTags] = useState('');
  const [saving, setSaving] = useState(false);
  const [vocab, setVocab] = useState<TagCount[]>([]);
  const [similar, setSimilar] = useState<Learning[]>([]);
  const [mergeTarget, setMergeTarget] = useState<Learning | null>(null);

  const prevOpen = useRef(false);
  // Monotonic token identifying the current distill. Each run() bumps it; async
  // results check they still match before calling setState. This drops the
  // results of any superseded run — a distill the user closed before it finished,
  // a Regenerate clicked while one was in flight, or a StrictMode double-invoke —
  // so the latest run always wins instead of a slower stale one clobbering it.
  const runToken = useRef(0);

  const loadSimilar = useCallback(
    async (draftTitle: string, draftTags: string[], token: number): Promise<void> => {
      const res = await window.fleet.learnings.similar(`${draftTitle} ${draftTags.join(' ')}`);
      if (token !== runToken.current) return;
      setSimilar(res);
    },
    []
  );

  const applyResult = useCallback(
    (res: DistillResult, tagVocab: TagCount[], token: number): void => {
      if (token !== runToken.current) return;
      if (res.status === 'ok') {
        const normTags = normalizeTags(res.draft.tags, tagVocab);
        setTitle(res.draft.title);
        setBody(res.draft.body);
        setTags(normTags.join(', '));
        setPhase('ready');
        void loadSimilar(res.draft.title, normTags, token);
      } else if (res.status === 'nothing') {
        setPhase('nothing');
      } else {
        setError(res.message);
        setPhase('error');
      }
    },
    [loadSimilar]
  );

  const run = useCallback(
    async (s: SessionSummary, node: string | undefined): Promise<void> => {
      const token = ++runToken.current;
      setPhase('loading');
      setError('');
      setSimilar([]);
      setMergeTarget(null);
      const [res, tagVocab] = await Promise.all([
        window.fleet.learnings.distill({ agent: s.agent, id: s.id, cwd: s.cwd, nodeId: node }),
        window.fleet.learnings.tags()
      ]);
      if (token !== runToken.current) return;
      setVocab(tagVocab);
      applyResult(res, tagVocab, token);
    },
    [applyResult]
  );

  // Kick off a distill each time the modal opens.
  useEffect(() => {
    if (open && !prevOpen.current && session) {
      setShown(session);
      setShownNode(nodeId);
      void run(session, nodeId);
    }
    prevOpen.current = open;
  }, [open, session, nodeId, run]);

  // On unmount, invalidate any in-flight run (its setState calls become no-ops)
  // and clear the rising-edge guard so a remount re-distills cleanly.
  useEffect(
    () => () => {
      runToken.current++;
      prevOpen.current = false;
    },
    []
  );

  function addTag(tag: string): void {
    setTags((prev) => unionTags(parseTags(prev), [tag]).join(', '));
  }

  async function save(): Promise<void> {
    if (!shown || title.trim() === '') return;
    const draftTags = parseTags(tags);
    setSaving(true);
    try {
      if (mergeTarget) {
        await window.fleet.learnings.update(mergeTarget.id, {
          body: `${mergeTarget.body.trim()}\n\n---\n\n${body.trim()}`,
          tags: unionTags(mergeTarget.tags, draftTags)
        });
      } else {
        await window.fleet.learnings.create({
          title: title.trim(),
          body: body.trim(),
          tags: draftTags,
          sourceAgent: shown.agent,
          sourceSessionId: shown.id,
          sourceCwd: shown.cwd,
          sourceProject: shown.project,
          model: shown.model
        });
      }
      onSaved?.();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPhase('error');
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const draftTags = parseTags(tags);
  const suggestions = vocab
    .filter((v) => !draftTags.some((t) => t.toLowerCase() === v.tag.toLowerCase()))
    .slice(0, 8);

  return (
    <Overlay open={open} onClose={onClose}>
      <div className="flex max-h-[80vh] w-[560px] flex-col rounded-lg border border-neutral-800 bg-neutral-900 p-4">
        <h2 className="mb-3 flex-shrink-0 text-sm font-semibold text-neutral-100">
          Distill learning
          {shown ? <span className="ml-2 text-neutral-500">· {shown.title}</span> : null}
          {shownNode ? <span className="ml-1 text-neutral-600">· branch</span> : null}
        </h2>

        {phase === 'loading' && (
          <div className="py-10 text-center text-sm text-neutral-400">
            Reading the session and distilling a learning…
            <div className="mt-1 text-xs text-neutral-600">
              Running a headless rune pass — this can take a moment.
            </div>
          </div>
        )}

        {phase === 'nothing' && (
          <div className="py-10 text-center text-sm text-neutral-400">
            Nothing notable to record from this session.
          </div>
        )}

        {phase === 'error' && (
          <div className="py-8 text-center text-sm text-red-400">{error || 'Distill failed.'}</div>
        )}

        {phase === 'ready' && (
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            {similar.length > 0 && (
              <div className="rounded border border-amber-500/30 bg-amber-500/10 px-2 py-2 text-xs text-amber-200">
                <div className="mb-1 font-medium">
                  {mergeTarget
                    ? `Merging into “${mergeTarget.title}”`
                    : 'Similar learnings already exist:'}
                </div>
                <div className="flex flex-col gap-1">
                  {similar.map((l) => {
                    const isTarget = mergeTarget?.id === l.id;
                    return (
                      <div key={l.id} className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-amber-100">{l.title}</span>
                        <button
                          onClick={() => setMergeTarget(isTarget ? null : l)}
                          className={`flex-shrink-0 rounded px-1.5 py-0.5 text-[11px] ${
                            isTarget
                              ? 'bg-amber-500/30 text-amber-100'
                              : 'text-amber-300 hover:bg-amber-500/20'
                          }`}
                        >
                          {isTarget ? 'Cancel merge' : 'Merge into'}
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <label className="block text-xs text-neutral-300">
              Title
              <input
                autoFocus
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                disabled={mergeTarget !== null}
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500 disabled:opacity-50"
              />
            </label>
            <label className="flex min-h-0 flex-1 flex-col text-xs text-neutral-300">
              Body (markdown)
              <textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="mt-1 min-h-[220px] flex-1 resize-none rounded border border-neutral-700 bg-neutral-950 px-2 py-1 font-mono text-xs leading-relaxed outline-none focus:border-blue-500"
              />
            </label>
            <label className="block text-xs text-neutral-300">
              Tags <span className="text-neutral-500">(comma-separated)</span>
              <input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="e.g. sqlite, testing"
                className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs outline-none focus:border-blue-500"
              />
            </label>
            {suggestions.length > 0 && (
              <div className="flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-neutral-500">Existing tags:</span>
                {suggestions.map((v) => (
                  <button
                    key={v.tag}
                    onClick={() => addTag(v.tag)}
                    className="rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] text-neutral-300 hover:bg-neutral-700"
                  >
                    {v.tag}
                    <span className="ml-1 text-neutral-500">{v.count}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="mt-3 flex flex-shrink-0 items-center justify-between">
          {phase === 'error' || phase === 'nothing' ? (
            <button
              onClick={() => shown && void run(shown, shownNode)}
              className="rounded px-3 py-1 text-xs text-neutral-300 transition hover:bg-neutral-800 active:scale-[0.97]"
            >
              Try again
            </button>
          ) : phase === 'ready' ? (
            <button
              onClick={() => shown && void run(shown, shownNode)}
              className="rounded px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 active:scale-[0.97]"
            >
              Regenerate
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="rounded px-3 py-1 text-xs text-neutral-400 transition hover:bg-neutral-800 active:scale-[0.97]"
            >
              {phase === 'ready' ? 'Cancel' : 'Close'}
            </button>
            {phase === 'ready' && (
              <button
                onClick={() => void save()}
                disabled={saving || title.trim() === ''}
                className="rounded bg-blue-600 px-3 py-1 text-xs text-white transition hover:bg-blue-500 active:scale-[0.97] disabled:opacity-50"
              >
                {saving ? 'Saving…' : mergeTarget ? 'Merge learning' : 'Save learning'}
              </button>
            )}
          </div>
        </div>
      </div>
    </Overlay>
  );
}
