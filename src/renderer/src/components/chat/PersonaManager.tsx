import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { PersonaPreset } from '../../../../shared/chat-types';

export function PersonaManager(): React.JSX.Element {
  const [personas, setPersonas] = useState<PersonaPreset[]>([]);
  const [defaultId, setDefaultId] = useState<string | null>(null);
  const loadPromptTemplates = useChatStore((s) => s.loadPromptTemplates);

  useEffect(() => {
    void window.fleet.chat.getSettings().then((s) => {
      setPersonas(s.personas);
      setDefaultId(s.defaultPersonaId);
    });
  }, []);

  const persist = async (next: PersonaPreset[], nextDefault: string | null): Promise<void> => {
    setPersonas(next);
    setDefaultId(nextDefault);
    await window.fleet.chat.patchSettings({ personas: next, defaultPersonaId: nextDefault });
    await loadPromptTemplates(); // refresh the composer persona selector
  };

  const add = (): void => {
    const p: PersonaPreset = { id: crypto.randomUUID(), name: 'New persona', prompt: '' };
    void persist([...personas, p], defaultId);
  };

  const update = (id: string, patch: Partial<PersonaPreset>): void => {
    void persist(
      personas.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      defaultId
    );
  };

  const remove = (id: string): void => {
    void persist(
      personas.filter((p) => p.id !== id),
      defaultId === id ? null : defaultId
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fleet-text-muted">
          Named system prompts applied per conversation. Pick one in the composer; set a default for
          new chats.
        </p>
        <button
          type="button"
          onClick={add}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-xs text-fleet-text-muted hover:text-fleet-text"
        >
          <Plus size={13} /> New
        </button>
      </div>

      {personas.length === 0 && (
        <p className="text-xs text-fleet-text-muted">No personas yet. Add one to start.</p>
      )}

      <div className="space-y-3">
        {personas.map((p) => (
          <div key={p.id} className="rounded border border-fleet-border bg-fleet-surface-2 p-2">
            <div className="flex items-center gap-2">
              <input
                value={p.name}
                onChange={(e) => update(p.id, { name: e.target.value })}
                placeholder="name"
                className="min-w-0 flex-1 rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text outline-none"
              />
              <label className="flex shrink-0 items-center gap-1 text-[11px] text-fleet-text-muted">
                <input
                  type="radio"
                  name="default-persona"
                  checked={defaultId === p.id}
                  onChange={() => void persist(personas, p.id)}
                />
                default
              </label>
              <button
                type="button"
                aria-label="Delete persona"
                onClick={() => remove(p.id)}
                className="rounded p-1 text-fleet-text-muted hover:text-red-400"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <textarea
              value={p.prompt}
              onChange={(e) => update(p.id, { prompt: e.target.value })}
              placeholder="System prompt for this persona…"
              rows={3}
              className="mt-2 w-full resize-y rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1 text-xs text-fleet-text outline-none"
            />
          </div>
        ))}
      </div>
    </div>
  );
}
