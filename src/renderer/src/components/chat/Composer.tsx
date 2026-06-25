import { useState } from 'react';
import { Send, Square } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';

type Props = { defaultModel: string };

export function Composer({ defaultModel }: Props): React.JSX.Element {
  const [text, setText] = useState('');
  const [model, setModel] = useState(defaultModel);
  const status = useChatStore((s) => s.status);
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const streaming = status === 'streaming';

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    void send(trimmed, model);
    setText('');
  };

  return (
    <div className="border-t border-fleet-border p-2">
      <div className="mb-1 flex items-center gap-2">
        <ModelPicker value={model} onChange={setModel} />
      </div>
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Message…"
          rows={2}
          className="min-h-0 flex-1 resize-none rounded border border-fleet-border bg-fleet-surface-2 px-3 py-2 text-sm text-fleet-text outline-none focus:border-fleet-border-strong"
        />
        {streaming ? (
          <button onClick={cancel} className="rounded bg-fleet-surface-3 p-2 text-fleet-text">
            <Square size={16} />
          </button>
        ) : (
          <button
            onClick={submit}
            className="rounded bg-fleet-accent/80 p-2 text-white hover:bg-fleet-accent"
          >
            <Send size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
