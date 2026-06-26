import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import {
  extractPromptVars,
  normalizePromptName,
  type PromptTemplate
} from '../../../../shared/prompt-types';

export function PromptLibraryTab(): React.JSX.Element {
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const loadPromptTemplates = useChatStore((s) => s.loadPromptTemplates);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => setTemplates(s.prompts));
  }, []);

  const persist = async (next: PromptTemplate[]): Promise<void> => {
    setTemplates(next);
    await window.fleet.chat.patchSettings({ prompts: next });
    await loadPromptTemplates(); // refresh the composer `/` menu
  };

  const add = (): void => {
    const tpl: PromptTemplate = {
      id: crypto.randomUUID(),
      name: 'new-prompt',
      description: '',
      content: ''
    };
    void persist([...templates, tpl]);
  };

  const update = (id: string, patch: Partial<PromptTemplate>): void => {
    void persist(templates.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };

  const remove = (id: string): void => {
    void persist(templates.filter((t) => t.id !== id));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fleet-text-muted">
          Reusable prompts invoked via <code>/name</code> in the composer. Add{' '}
          <code>{'{{variable}}'}</code> tokens to pop a fill-in form before inserting.
        </p>
        <button
          type="button"
          onClick={add}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-fleet-text-muted hover:text-fleet-text"
        >
          <Plus size={13} /> New
        </button>
      </div>

      {templates.length === 0 && (
        <p className="text-xs text-fleet-text-muted">No prompt templates yet. Add one to start.</p>
      )}

      <div className="space-y-3">
        {templates.map((t) => {
          const vars = extractPromptVars(t.content);
          return (
            <div key={t.id} className="rounded border border-fleet-border bg-fleet-surface-2 p-2">
              <div className="flex items-center gap-2">
                <span className="text-fleet-text-muted">/</span>
                <input
                  value={t.name}
                  onChange={(e) => update(t.id, { name: e.target.value })}
                  onBlur={(e) => update(t.id, { name: normalizePromptName(e.target.value) })}
                  placeholder="name"
                  className="w-40 rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1 font-mono text-xs text-fleet-text outline-none"
                />
                <input
                  value={t.description}
                  onChange={(e) => update(t.id, { description: e.target.value })}
                  placeholder="description"
                  className="min-w-0 flex-1 rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text outline-none"
                />
                <button
                  type="button"
                  aria-label="Delete template"
                  onClick={() => remove(t.id)}
                  className="rounded p-1 text-fleet-text-muted hover:text-red-400"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <textarea
                value={t.content}
                onChange={(e) => update(t.id, { content: e.target.value })}
                placeholder="Prompt body — use {{variable}} for fill-in fields"
                rows={3}
                className="mt-2 w-full resize-y rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1 font-mono text-xs text-fleet-text outline-none"
              />
              {vars.length > 0 && (
                <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px] text-fleet-text-muted">
                  <span>variables:</span>
                  {vars.map((v) => (
                    <span key={v} className="rounded bg-fleet-surface-3 px-1.5 py-0.5 font-mono">
                      {v}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
