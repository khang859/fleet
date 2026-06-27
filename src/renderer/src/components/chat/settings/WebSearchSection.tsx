import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field } from './primitives';
import { Toggle } from './Toggle';
import { SecretInput } from './SecretInput';
import { inputCls, selectCls } from './controls';
import { WEB_SEARCH_PROVIDERS, type WebSearchProviderId } from '../../../../../shared/chat-types';

function asProviderId(v: string): WebSearchProviderId {
  return WEB_SEARCH_PROVIDERS.find((p) => p.id === v)?.id ?? 'tavily';
}

export function WebSearchSection(): React.JSX.Element {
  const { settings, patch, searchKeyPresent, saveSearchKey, clearSearchKey } = useChatSettings();
  const { webSearch } = settings;
  const providerMeta = WEB_SEARCH_PROVIDERS.find((p) => p.id === webSearch.provider);

  return (
    <SectionShell
      title="Web Search"
      description="Let tool-capable models look things up. Each search is approved via the tool-call card."
    >
      <FieldGroup>
        <Field
          label="Enable web search"
          description="Offer the web_search tool (requires a provider API key)."
          htmlFor="websearch-enable"
        >
          <Toggle
            id="websearch-enable"
            checked={webSearch.enabled}
            onChange={(v) => void patch({ webSearch: { ...webSearch, enabled: v } })}
          />
        </Field>

        <Field label="Provider">
          <select
            value={webSearch.provider}
            onChange={(e) =>
              void patch({ webSearch: { ...webSearch, provider: asProviderId(e.target.value) } })
            }
            className={selectCls}
          >
            {WEB_SEARCH_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label={`${providerMeta?.name ?? 'Provider'} API key`}
          description="Stored encrypted, per provider."
          layout="stack"
        >
          <SecretInput
            key={webSearch.provider}
            present={searchKeyPresent}
            onSave={saveSearchKey}
            onClear={clearSearchKey}
            placeholder={providerMeta?.keyPlaceholder}
          />
        </Field>

        <Field label="Max results">
          <input
            type="number"
            min={1}
            max={20}
            value={webSearch.maxResults}
            onChange={(e) =>
              void patch({
                webSearch: {
                  ...webSearch,
                  maxResults: Math.min(20, Math.max(1, Number(e.target.value) || 1))
                }
              })
            }
            className={`${inputCls} w-20`}
          />
        </Field>
      </FieldGroup>
    </SectionShell>
  );
}
