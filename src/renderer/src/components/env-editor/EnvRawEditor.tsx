type Props = {
  text: string;
  onChange: (text: string) => void;
};

export function EnvRawEditor({ text, onChange }: Props): React.JSX.Element {
  return (
    <textarea
      value={text}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      className="flex-1 resize-none bg-neutral-950 p-4 font-mono text-xs leading-relaxed text-neutral-200 outline-none"
      placeholder="# KEY=value"
    />
  );
}
