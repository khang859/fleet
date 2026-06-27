import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field } from './primitives';
import { Toggle } from './Toggle';
import { inputCls } from './controls';

export function ComposerSection(): React.JSX.Element {
  const { settings, patch } = useChatSettings();
  const { uploads, tools } = settings;

  return (
    <SectionShell
      title="Composer"
      description="What you can pull into a message — attachments and @-mentioned files."
    >
      <FieldGroup title="Attachments">
        <Field
          label="Allow PDF uploads"
          description="Images are always allowed. Sent to vision-capable models as context."
          htmlFor="allow-pdf"
        >
          <Toggle
            id="allow-pdf"
            checked={uploads.pdf}
            onChange={(v) => void patch({ uploads: { ...uploads, pdf: v } })}
          />
        </Field>
        <Field label="Max attachment size">
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={50}
              value={uploads.maxMb}
              onChange={(e) =>
                void patch({
                  uploads: {
                    ...uploads,
                    maxMb: Math.min(50, Math.max(1, Number(e.target.value) || 1))
                  }
                })
              }
              className={`${inputCls} w-20`}
            />
            <span className="text-xs text-fleet-text-muted">MB / file</span>
          </div>
        </Field>
      </FieldGroup>

      <FieldGroup title="@-mentions">
        <Field
          label="File size limit"
          description="Type @ in the composer to pin repo files into context. Each is truncated to this size."
        >
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              value={tools.mentionMaxKb}
              onChange={(e) =>
                void patch({
                  tools: { ...tools, mentionMaxKb: Math.max(1, Number(e.target.value) || 1) }
                })
              }
              className={`${inputCls} w-24`}
            />
            <span className="text-xs text-fleet-text-muted">KB / file</span>
          </div>
        </Field>
      </FieldGroup>
    </SectionShell>
  );
}
