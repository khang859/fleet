import { ModelPicker } from '../ModelPicker';
import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field } from './primitives';
import { SecretInput } from './SecretInput';

function validateOpenRouterKey(key: string): string | null {
  if (/\s/.test(key)) return 'Keys cannot contain spaces.';
  if (!key.startsWith('sk-or-')) return 'OpenRouter keys start with "sk-or-".';
  return null;
}

export function ModelsSection(): React.JSX.Element {
  const { settings, patch, keyPresent, saveKey, clearKey } = useChatSettings();

  return (
    <SectionShell
      title="Models"
      description="The provider and models powering chat and image generation."
    >
      <FieldGroup>
        <Field
          label="OpenRouter API key"
          description="Stored encrypted on this device. Required to chat and to list models."
          layout="stack"
          htmlFor="openrouter-key"
        >
          <SecretInput
            inputId="openrouter-key"
            present={keyPresent}
            onSave={saveKey}
            onClear={clearKey}
            placeholder="sk-or-…"
            validate={validateOpenRouterKey}
          />
        </Field>
      </FieldGroup>

      <FieldGroup>
        <Field label="Default model" description="Used for new conversations." layout="stack">
          <ModelPicker
            value={settings.defaultModel}
            onChange={(m) => {
              if (m) void patch({ defaultModel: m });
            }}
          />
        </Field>
        <Field
          label="Image model"
          description="Enables the in-chat image generation tool. None turns it off; only offered when the active model supports tools."
          layout="stack"
        >
          <ModelPicker
            source="image"
            allowNone
            value={settings.imageModel}
            onChange={(m) => void patch({ imageModel: m })}
          />
        </Field>
      </FieldGroup>
    </SectionShell>
  );
}
