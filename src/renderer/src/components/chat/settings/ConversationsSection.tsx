import { ModelPicker } from '../ModelPicker';
import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field } from './primitives';
import { Toggle } from './Toggle';
import { selectCls } from './controls';

export function ConversationsSection(): React.JSX.Element {
  const { settings, patch } = useChatSettings();

  return (
    <SectionShell title="Conversations" description="How chats are named, organized, and exported.">
      <FieldGroup title="Naming">
        <Field
          label="Auto-name new chats"
          description="Generate a title from the first exchange."
          htmlFor="auto-name"
        >
          <Toggle
            id="auto-name"
            checked={settings.autoName}
            onChange={(v) => void patch({ autoName: v })}
          />
        </Field>

        {settings.autoName && (
          <div className="space-y-4 border-l-2 border-fleet-border pl-4 duration-150 animate-in fade-in slide-in-from-top-1">
            <Field
              label="Naming model"
              description="A cheap model for background titling. None uses the default model."
              layout="stack"
            >
              <ModelPicker
                allowNone
                noneSubtitle="Use the default model"
                value={settings.taskModel}
                onChange={(m) => void patch({ taskModel: m })}
              />
            </Field>
            <Field label="Timing">
              <select
                value={settings.namingTiming}
                onChange={(e) =>
                  void patch({
                    namingTiming: e.target.value === 'immediate' ? 'immediate' : 'after-response'
                  })
                }
                className={selectCls}
              >
                <option value="after-response">After first response</option>
                <option value="immediate">Immediately from first message</option>
              </select>
            </Field>
          </div>
        )}

        <Field
          label="Auto-tag new chats"
          description="Generate topical labels in the background."
          htmlFor="auto-tag"
        >
          <Toggle
            id="auto-tag"
            checked={settings.autoTag}
            onChange={(v) => void patch({ autoTag: v })}
          />
        </Field>
      </FieldGroup>

      <FieldGroup title="Sidebar & export">
        <Field label="Default sort" description="Pinned conversations always sort first.">
          <select
            value={settings.conversationSort}
            onChange={(e) =>
              void patch({
                conversationSort: e.target.value === 'alphabetical' ? 'alphabetical' : 'recent'
              })
            }
            className={selectCls}
          >
            <option value="recent">Most recent</option>
            <option value="alphabetical">Alphabetical</option>
          </select>
        </Field>
        <Field label="Export format" description="Default format for the export action.">
          <select
            value={settings.exportFormat}
            onChange={(e) =>
              void patch({ exportFormat: e.target.value === 'json' ? 'json' : 'markdown' })
            }
            className={selectCls}
          >
            <option value="markdown">Markdown (.md)</option>
            <option value="json">JSON (.json)</option>
          </select>
        </Field>
      </FieldGroup>
    </SectionShell>
  );
}
