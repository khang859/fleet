import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field } from './primitives';
import { Toggle } from './Toggle';
import { inputCls } from './controls';

export function WebFetchSection(): React.JSX.Element {
  const { settings, patch } = useChatSettings();
  const { webFetch } = settings;

  return (
    <SectionShell
      title="Web Fetch"
      description="Let tool-capable models read a page by URL. Each fetch is approved via the tool-call card. JavaScript-rendered pages are rendered in a hidden browser, then cleaned to markdown."
    >
      <FieldGroup>
        <Field
          label="Enable web fetch"
          description="Offer the web_fetch tool (no API key required)."
          htmlFor="webfetch-enable"
        >
          <Toggle
            id="webfetch-enable"
            checked={webFetch.enabled}
            onChange={(v) => void patch({ webFetch: { ...webFetch, enabled: v } })}
          />
        </Field>

        <Field
          label="Max characters"
          description="Cleaned content is truncated to this length before it reaches the model."
        >
          <input
            type="number"
            min={1000}
            max={200000}
            step={1000}
            value={webFetch.maxChars}
            onChange={(e) =>
              void patch({
                webFetch: {
                  ...webFetch,
                  maxChars: Math.min(200000, Math.max(1000, Number(e.target.value) || 1000))
                }
              })
            }
            className={`${inputCls} w-28`}
          />
        </Field>
      </FieldGroup>
    </SectionShell>
  );
}
