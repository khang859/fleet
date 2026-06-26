import { useRef, useState } from 'react';
import { Paperclip, Send, Square, X, File, Folder, Wand2, Sparkles, FileText } from 'lucide-react';
import { useChatStore } from '../../store/chat-store';
import type { ChatMentionItem } from '../../../../shared/chat-types';
import type { PromptTemplate } from '../../../../shared/prompt-types';
import { extractPromptVars, fillTemplate } from '../../../../shared/prompt-types';
import { ModelPicker } from './ModelPicker';

const MENTION_RE = /(?:^|\s)@([\w./-]*)$/;

/** A unified `/` menu entry: an installed skill or a saved prompt template. */
type CommandItem =
  | { kind: 'skill'; name: string; description: string }
  | { kind: 'prompt'; name: string; description: string; template: PromptTemplate };

type Props = { defaultModel: string };

type Attachment = { dataUrl: string; name: string; isPdf: boolean };

export function Composer({ defaultModel }: Props): React.JSX.Element {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const status = useChatStore((s) => s.status);
  const uploads = useChatStore((s) => s.uploads);
  const send = useChatStore((s) => s.send);
  const cancel = useChatStore((s) => s.cancel);
  const activeId = useChatStore((s) => s.activeId);
  const setConversationModel = useChatStore((s) => s.setConversationModel);
  const setConversationPersona = useChatStore((s) => s.setConversationPersona);
  const personas = useChatStore((s) => s.personas);
  const personaId = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.personaId ?? null
  );
  const skillMenu = useChatStore((s) => s.skillMenu);
  const promptTemplates = useChatStore((s) => s.promptTemplates);
  const model = useChatStore(
    (s) => s.conversations.find((c) => c.id === s.activeId)?.model ?? defaultModel
  );
  const streaming = status === 'streaming';

  // `/` command autocomplete (skills + prompt templates): open while the whole
  // input is a single slash token.
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const commands: CommandItem[] = [
    ...skillMenu.map((s) => ({ kind: 'skill' as const, name: s.name, description: s.description })),
    ...promptTemplates.map((p) => ({
      kind: 'prompt' as const,
      name: p.name,
      description: p.description,
      template: p
    }))
  ];
  const slashMatch = /^\/([A-Za-z0-9_.-]*)$/.exec(text);
  const matches = slashMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith(slashMatch[1].toLowerCase()))
    : [];
  const menuOpen = matches.length > 0 && !menuDismissed;
  const activeIndex = Math.min(menuIndex, matches.length - 1);

  // Prompt-template fill-in form, shown when a `/template` with `{{vars}}` is picked.
  const [formPrompt, setFormPrompt] = useState<PromptTemplate | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});

  const pickCommand = (cmd: CommandItem): void => {
    setMenuIndex(0);
    setMenuDismissed(true);
    if (cmd.kind === 'skill') {
      setText(`/${cmd.name} `);
      textareaRef.current?.focus();
      return;
    }
    const vars = extractPromptVars(cmd.template.content);
    if (vars.length > 0) {
      setFormPrompt(cmd.template);
      setFormValues(Object.fromEntries(vars.map((v) => [v, ''])));
      setText('');
    } else {
      setText(cmd.template.content);
      textareaRef.current?.focus();
    }
  };

  const applyForm = (): void => {
    if (!formPrompt) return;
    setText(fillTemplate(formPrompt.content, formValues));
    setFormPrompt(null);
    setFormValues({});
    textareaRef.current?.focus();
  };

  // `@` file/folder mentions: end-anchored token → autocomplete → pinned chips.
  const [mentions, setMentions] = useState<string[]>([]);
  const [mentionResults, setMentionResults] = useState<ChatMentionItem[]>([]);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const mentionOpen = mentionResults.length > 0 && !mentionDismissed && MENTION_RE.test(text);
  const mentionActive = Math.min(mentionIndex, mentionResults.length - 1);

  const onTextChange = (value: string): void => {
    setText(value);
    setMenuDismissed(false);
    const m = MENTION_RE.exec(value);
    if (m) {
      setMentionDismissed(false);
      setMentionIndex(0);
      void window.fleet.chat.mentionSearch(m[1]).then(setMentionResults);
    } else {
      setMentionResults([]);
    }
  };

  const pickMention = (path: string): void => {
    setText((t) => t.replace(MENTION_RE, (s) => (s.startsWith(' ') ? ' ' : '')));
    setMentions((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setMentionResults([]);
    setMentionDismissed(true);
    textareaRef.current?.focus();
  };

  const removeMention = (path: string): void => {
    setMentions((prev) => prev.filter((p) => p !== path));
  };

  const imageTypes = ['image/png', 'image/jpeg', 'image/webp'];
  const acceptAttr = uploads.pdf ? `${imageTypes.join(',')},application/pdf` : imageTypes.join(',');

  const acceptFile = (file: File): void => {
    const isPdf = file.type === 'application/pdf';
    const allowed = imageTypes.includes(file.type) || (isPdf && uploads.pdf);
    if (!allowed) {
      setAttachError(uploads.pdf ? 'Images or PDF only' : 'PNG, JPG, or WebP only');
      return;
    }
    if (file.size > uploads.maxMb * 1024 * 1024) {
      setAttachError(`File must be under ${uploads.maxMb} MB`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setAttachError(null);
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      setAttachments((prev) => [...prev, { dataUrl, name: file.name, isPdf }]);
    };
    reader.onerror = () => setAttachError("Couldn't read that file — try another");
    reader.readAsDataURL(file);
  };

  const removeAttachment = (index: number): void => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  const submit = (): void => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0) || streaming) return;
    void send(
      trimmed,
      model,
      attachments.length ? attachments.map((a) => a.dataUrl) : undefined,
      mentions.length ? mentions : undefined
    );
    setText('');
    setAttachments([]);
    setAttachError(null);
    setMentions([]);
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
        for (const file of Array.from(e.dataTransfer.files)) acceptFile(file);
      }}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded border-2 border-dashed border-fleet-accent bg-fleet-surface-2/80">
          <span className="text-sm text-fleet-text-muted">Drop file to attach</span>
        </div>
      )}
      <div className="mb-1 flex items-center gap-2">
        <ModelPicker
          value={model}
          onChange={(m) => {
            if (m && activeId) void setConversationModel(activeId, m);
          }}
        />
        {personas.length > 0 && (
          <select
            aria-label="Persona"
            value={personaId ?? ''}
            onChange={(e) => {
              if (activeId) void setConversationPersona(activeId, e.target.value || null);
            }}
            className="rounded border border-fleet-border bg-fleet-surface-2 px-2 py-1 text-xs text-fleet-text outline-none"
          >
            <option value="">No persona</option>
            {personas.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((a, i) => (
            <div key={`${a.name}-${i}`} className="flex items-center gap-2">
              {a.isPdf ? (
                <span className="flex h-10 items-center gap-1 rounded bg-fleet-surface-3 px-2 text-xs text-fleet-text">
                  <FileText size={14} className="text-fleet-text-muted" />
                  <span className="max-w-[140px] truncate">{a.name}</span>
                </span>
              ) : (
                <img src={a.dataUrl} alt={a.name} className="h-10 w-10 rounded object-cover" />
              )}
              <button
                type="button"
                aria-label={`Remove ${a.name}`}
                onClick={() => {
                  removeAttachment(i);
                  textareaRef.current?.focus();
                }}
                className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
              >
                <X size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
      {formPrompt && (
        <div className="mb-2 rounded border border-fleet-border bg-fleet-surface-2 p-2">
          <div className="mb-2 flex items-center gap-1.5 text-xs text-fleet-text">
            <Wand2 size={13} className="text-fleet-text-muted" />
            <span className="font-mono">/{formPrompt.name}</span>
            <button
              type="button"
              aria-label="Cancel template"
              onClick={() => {
                setFormPrompt(null);
                setFormValues({});
                textareaRef.current?.focus();
              }}
              className="ml-auto rounded p-0.5 text-fleet-text-muted hover:text-fleet-text"
            >
              <X size={13} />
            </button>
          </div>
          <div className="space-y-2">
            {Object.keys(formValues).map((v) => (
              <label key={v} className="block">
                <span className="mb-0.5 block font-mono text-[11px] text-fleet-text-secondary">
                  {v}
                </span>
                <textarea
                  value={formValues[v]}
                  onChange={(e) => setFormValues((prev) => ({ ...prev, [v]: e.target.value }))}
                  rows={1}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                      e.preventDefault();
                      applyForm();
                    }
                  }}
                  className="w-full resize-y rounded border border-fleet-border bg-fleet-surface-3 px-2 py-1 text-sm text-fleet-text outline-none"
                />
              </label>
            ))}
          </div>
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              onClick={applyForm}
              className="rounded bg-fleet-accent/80 px-3 py-1 text-xs text-white hover:bg-fleet-accent"
            >
              Insert
            </button>
          </div>
        </div>
      )}
      {mentions.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1">
          {mentions.map((p) => (
            <span
              key={p}
              className="flex items-center gap-1 rounded bg-fleet-surface-3 px-2 py-0.5 text-[11px] text-fleet-text"
            >
              <span className="max-w-[200px] truncate font-mono">@{p}</span>
              <button
                type="button"
                aria-label={`Remove ${p}`}
                onClick={() => removeMention(p)}
                className="text-fleet-text-muted hover:text-fleet-text"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative flex items-end gap-2">
        {mentionOpen && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto rounded border border-fleet-border bg-fleet-surface-2 py-1 shadow-lg">
            {mentionResults.map((r, i) => (
              <li key={r.path}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickMention(r.path);
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                  className={`flex w-full items-center gap-2 px-3 py-1.5 text-left ${
                    i === mentionActive ? 'bg-fleet-surface-3' : ''
                  }`}
                >
                  {r.type === 'dir' ? (
                    <Folder size={12} className="shrink-0 text-fleet-text-muted" />
                  ) : (
                    <File size={12} className="shrink-0 text-fleet-text-muted" />
                  )}
                  <span className="truncate font-mono text-xs text-fleet-text">{r.path}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {menuOpen && !mentionOpen && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 max-h-56 w-full overflow-y-auto rounded border border-fleet-border bg-fleet-surface-2 py-1 shadow-lg">
            {matches.map((s, i) => (
              <li key={`${s.kind}:${s.name}`}>
                <button
                  type="button"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pickCommand(s);
                  }}
                  onMouseEnter={() => setMenuIndex(i)}
                  className={`flex w-full items-center gap-1.5 px-3 py-1.5 text-left ${
                    i === activeIndex ? 'bg-fleet-surface-3' : ''
                  }`}
                >
                  {s.kind === 'prompt' ? (
                    <Wand2 size={12} className="shrink-0 text-fleet-text-muted" />
                  ) : (
                    <Sparkles size={12} className="shrink-0 text-fleet-text-muted" />
                  )}
                  <span className="font-mono text-xs text-fleet-text">/{s.name}</span>
                  <span className="ml-1 line-clamp-1 text-[11px] text-fleet-text-muted">
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
          onChange={(e) => onTextChange(e.target.value)}
          onKeyDown={(e) => {
            if (mentionOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setMentionIndex((i) => (i + 1) % mentionResults.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setMentionIndex((i) => (i - 1 + mentionResults.length) % mentionResults.length);
                return;
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault();
                pickMention(mentionResults[mentionActive].path);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setMentionDismissed(true);
                return;
              }
            }
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
                pickCommand(matches[activeIndex]);
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
            const file = e.clipboardData.files.item(0);
            if (file && (file.type.startsWith('image/') || file.type === 'application/pdf')) {
              e.preventDefault();
              acceptFile(file);
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
          aria-label="Attach file"
          onClick={() => fileRef.current?.click()}
          className="rounded p-1 text-fleet-text-muted hover:text-fleet-text"
        >
          <Paperclip size={14} />
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={acceptAttr}
          multiple
          className="hidden"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            for (const file of Array.from(e.target.files ?? [])) acceptFile(file);
            e.target.value = '';
          }}
        />
        <span className="text-xs text-fleet-text-muted">
          {uploads.pdf ? 'Images or PDF' : 'PNG, JPG, WebP'} · up to {uploads.maxMb} MB
        </span>
        {attachError && <span className="text-xs text-red-400">{attachError}</span>}
      </div>
    </div>
  );
}
