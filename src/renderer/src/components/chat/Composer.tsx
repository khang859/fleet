import { useRef, useState } from 'react';
import { Paperclip, Send, Square, X } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import { ModelPicker } from './ModelPicker';

type Props = { defaultModel: string };

export function Composer({ defaultModel }: Props): React.JSX.Element {
  const [text, setText] = useState('');
  const [attachment, setAttachment] = useState<{ dataUrl: string; name: string } | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const MAX_BYTES = 10 * 1024 * 1024;

  const status = useChatStore((s) => s.status);
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const activeId = useChatStore((s) => s.activeId);
  const setConversationModel = useChatStore((s) => s.setConversationModel);
  const skillMenu = useChatStore((s) => s.skillMenu);
  const model = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.model ?? defaultModel
  );
  const streaming = status === 'streaming';

  // `/` skill autocomplete: open while the whole input is a single slash token.
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const slashMatch = /^\/([A-Za-z0-9_-]*)$/.exec(text);
  const matches = slashMatch
    ? skillMenu.filter((s) => s.name.toLowerCase().startsWith(slashMatch[1].toLowerCase()))
    : [];
  const menuOpen = matches.length > 0 && !menuDismissed;
  const activeIndex = Math.min(menuIndex, matches.length - 1);

  const pickSkill = (name: string): void => {
    setText(`/${name} `);
    setMenuIndex(0);
    setMenuDismissed(true);
    textareaRef.current?.focus();
  };

  const acceptFile = (file: File): void => {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      setAttachError('PNG, JPG, or WebP only');
      return;
    }
    if (file.size > MAX_BYTES) {
      setAttachError('Image must be under 10 MB');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachError(null);
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      setAttachment({ dataUrl, name: file.name });
    };
    reader.onerror = () => setAttachError("Couldn't read that image — try another file");
    reader.readAsDataURL(file);
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if ((!trimmed && !attachment) || streaming) return;
    void send(trimmed, model, attachment ? [attachment.dataUrl] : undefined);
    setText('');
    setAttachment(null);
    setAttachError(null);
  };

  return (
    <div
      className="relative border-t border-fleet-border p-2"
      onDragOver={(e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e: React.DragEvent) => {
        e.preventDefault();
        setDragOver(false);
        const file = e.dataTransfer.files.item(0);
        if (file) acceptFile(file);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded border-2 border-dashed border-fleet-accent bg-fleet-surface-2/80">
          <span className="text-sm text-fleet-text-muted">Drop image to attach</span>
        </div>
      )}
      <div className="mb-1 flex items-center gap-2">
        <ModelPicker
          value={model}
          onChange={(m) => {
            if (m && activeId) void setConversationModel(activeId, m);
          }}
        />
      </div>
      {attachment && (
        <div className="mb-2 flex items-center gap-2">
          <img
            src={attachment.dataUrl}
            alt={attachment.name}
            className="h-10 w-10 rounded object-cover"
          />
          <span className="max-w-[160px] truncate text-xs text-fleet-text-muted">
            {attachment.name}
          </span>
          <button
            type="button"
            aria-label="Remove attached image"
            onClick={() => {
              setAttachment(null);
              textareaRef.current?.focus();
            }}
            className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {menuOpen && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto rounded border border-fleet-border bg-fleet-surface-2 py-1 shadow-lg">
            {matches.map((s, i) => (
              <li key={s.name}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickSkill(s.name);
                  }}
                  onMouseEnter={() => setMenuIndex(i)}
                  className={`block w-full px-3 py-1.5 text-left ${
                    i === activeIndex ? 'bg-fleet-surface-3' : ''
                  }`}
                >
                  <span className="font-mono text-xs text-fleet-text">/{s.name}</span>
                  <span className="ml-2 line-clamp-1 text-[11px] text-fleet-text-muted">
                    {s.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setMenuDismissed(false);
          }}
          onKeyDown={(e) => {
            if (menuOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMenuIndex((i) => (i + 1) % matches.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMenuIndex((i) => (i - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickSkill(matches[activeIndex].name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMenuDismissed(true);
                return;
              }
            }
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
            const files = e.clipboardData.files;
            if (files.length > 0 && files[0].type.startsWith('image/')) {
              e.preventDefault();
              acceptFile(files[0]);
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
      <div className="mt-1 flex items-center gap-2">
        <button
          type="button"
          aria-label="Attach image"
          onClick={() => fileRef.current?.click()}
          className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
        >
          <Paperclip size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            const file = e.target.files?.[0];
            if (file) acceptFile(file);
            e.target.value = '';
          }}
        />
        <span className="text-xs text-fleet-text-muted">PNG, JPG, WebP · up to 10 MB</span>
        {attachError && <span className="text-xs text-red-400">{attachError}</span>}
      </div>
    </div>
  );
}
