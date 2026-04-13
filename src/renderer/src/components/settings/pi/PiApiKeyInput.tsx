import type { PiApiKey } from '../../../../../shared/pi-config-types';

type Props = {
  value: PiApiKey | undefined;
  onChange: (next: PiApiKey | undefined) => void;
};

type KindMeta = {
  kind: PiApiKey['kind'];
  label: string;
  placeholder: string;
  help: string;
};

const KINDS: KindMeta[] = [
  { kind: 'envVar', label: 'Env var', placeholder: 'MY_API_KEY', help: 'Reads process.env[name] at request time.' },
  { kind: 'literal', label: 'Literal', placeholder: 'sk-...', help: 'Stored in plain text in models.json.' },
  { kind: 'shell', label: 'Shell cmd', placeholder: 'security find-generic-password -ws anthropic', help: 'Runs the command and uses stdout.' }
];

function metaFor(kind: PiApiKey['kind']): KindMeta {
  return KINDS.find((k) => k.kind === kind) ?? KINDS[0];
}

export function PiApiKeyInput({ value, onChange }: Props): React.JSX.Element {
  const kind: PiApiKey['kind'] = value?.kind ?? 'envVar';
  const current = metaFor(kind);

  const text =
    value === undefined
      ? ''
      : value.kind === 'envVar'
        ? value.name
        : value.kind === 'literal'
          ? value.value
          : value.command;

  const handleTextChange = (raw: string): void => {
    if (!raw) {
      onChange(undefined);
      return;
    }
    if (kind === 'envVar') onChange({ kind: 'envVar', name: raw });
    else if (kind === 'literal') onChange({ kind: 'literal', value: raw });
    else onChange({ kind: 'shell', command: raw });
  };

  const handleKindChange = (nextKind: PiApiKey['kind']): void => {
    if (nextKind === kind) return;
    if (!text) {
      onChange(undefined);
      return;
    }
    if (nextKind === 'envVar') onChange({ kind: 'envVar', name: text });
    else if (nextKind === 'literal') onChange({ kind: 'literal', value: text });
    else onChange({ kind: 'shell', command: text });
  };

  return (
    <div className="space-y-1">
      <div className="flex gap-0 rounded overflow-hidden border border-neutral-700 w-fit">
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => handleKindChange(k.kind)}
            className={`px-2 py-1 text-xs ${
              k.kind === kind
                ? 'bg-neutral-700 text-neutral-100'
                : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <input
        type={kind === 'literal' ? 'password' : 'text'}
        value={text}
        onChange={(e) => handleTextChange(e.target.value)}
        placeholder={current.placeholder}
        className="w-full bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700 placeholder:text-neutral-600"
      />
      <p className="text-xs text-neutral-500">{current.help}</p>
      {kind === 'literal' && (
        <p className="text-xs text-amber-400/80">
          ⚠ Stored in plain text in <code>~/.pi/agent/models.json</code>.
        </p>
      )}
    </div>
  );
}
