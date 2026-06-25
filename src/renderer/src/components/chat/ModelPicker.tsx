import { useEffect, useState } from 'react';
import { useChatStore } from '../../store/chat-store';

type Props = { value: string; onChange: (modelId: string) => void };

export function ModelPicker({ value, onChange }: Props): React.JSX.Element {
  const models = useChatStore((s) => s.models);
  const loadModels = useChatStore((s) => s.loadModels);
  const keyPresent = useChatStore((s) => s.keyPresent);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (keyPresent && models.length === 0) void loadModels();
  }, [keyPresent, models.length, loadModels]);

  const filtered = models.filter(
    (m) =>
      m.id.toLowerCase().includes(query.toLowerCase()) ||
      m.name.toLowerCase().includes(query.toLowerCase())
  );

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => setQuery((q) => (e.key.length === 1 ? q + e.key : q))}
      className="rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text"
    >
      {value && !filtered.some((m) => m.id === value) && <option value={value}>{value}</option>}
      {filtered.slice(0, 200).map((m) => (
        <option key={m.id} value={m.id}>
          {m.name} ({Math.round(m.contextLength / 1000)}k)
        </option>
      ))}
    </select>
  );
}
