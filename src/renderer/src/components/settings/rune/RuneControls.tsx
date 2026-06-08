import { SettingRow } from '../SettingRow';

const selectClass =
  'bg-neutral-800 text-sm text-neutral-200 rounded px-2 py-1 border border-neutral-700';

type Option = { value: string; label: string };
type Options = ReadonlyArray<string | Option>;

function toOptions(options: Options): Option[] {
  return options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
}

export function RuneSelect({
  label,
  value,
  options,
  onChange
}: {
  label: string;
  value: string;
  options: Options;
  onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <SettingRow label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className={selectClass}>
        {toOptions(options).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </SettingRow>
  );
}

export function RuneToggle({
  label,
  checked,
  onChange
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <SettingRow label={label}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="fleet-accent-input"
      />
    </SettingRow>
  );
}

export function RuneText({
  label,
  value,
  placeholder,
  onCommit,
  widthClass = 'w-64'
}: {
  label: string;
  value: string;
  placeholder?: string;
  onCommit: (value: string) => void;
  widthClass?: string;
}): React.JSX.Element {
  return (
    <SettingRow label={label}>
      <input
        type="text"
        defaultValue={value}
        key={value}
        placeholder={placeholder}
        onBlur={(e) => {
          if (e.target.value !== value) onCommit(e.target.value);
        }}
        className={`${selectClass} ${widthClass}`}
      />
    </SettingRow>
  );
}
