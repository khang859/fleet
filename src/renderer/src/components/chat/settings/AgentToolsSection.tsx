import { PermissionRulesEditor } from '../PermissionRulesEditor';
import { useChatSettings } from './use-chat-settings';
import { SectionShell, FieldGroup, Field, Disclosure } from './primitives';
import { Toggle } from './Toggle';
import { inputCls, selectCls } from './controls';
import type { ChatToolsMode } from '../../../../../shared/chat-types';

const TOOL_MODES: ChatToolsMode[] = ['off', 'read-only', 'ask', 'auto'];
function asToolsMode(v: string): ChatToolsMode {
  return TOOL_MODES.find((m) => m === v) ?? 'read-only';
}

export function AgentToolsSection(): React.JSX.Element {
  const { settings, patch } = useChatSettings();
  const { tools, permissions } = settings;

  return (
    <SectionShell
      title="Agent & Tools"
      description="Gate what the agent may run. Read tools never prompt; only bash is gated."
    >
      <FieldGroup>
        <Field label="Mode" description="Controls file and shell tool access.">
          <select
            value={tools.mode}
            onChange={(e) => void patch({ tools: { ...tools, mode: asToolsMode(e.target.value) } })}
            className={selectCls}
          >
            <option value="off">Off — no file or shell tools</option>
            <option value="read-only">Read-only — read/glob/search</option>
            <option value="ask">Ask — shell prompts for approval</option>
            <option value="auto">Auto — sandboxed shell, no prompt</option>
          </select>
        </Field>

        <Field
          label="Permission rules"
          description="Tool(pattern) rules, evaluated deny → ask → allow."
          layout="stack"
        >
          <PermissionRulesEditor
            rules={permissions}
            onChange={(next) => void patch({ permissions: next })}
          />
        </Field>
      </FieldGroup>

      <Disclosure label="Advanced">
        <Field
          label="Workspace directory"
          description="Default cwd for tools and the sandbox writable root."
          layout="stack"
        >
          <input
            value={tools.workspaceDir ?? ''}
            placeholder="Default: app working directory"
            onChange={(e) =>
              void patch({ tools: { ...tools, workspaceDir: e.target.value.trim() || null } })
            }
            className={`${inputCls} w-full font-mono text-xs`}
          />
        </Field>
        <Field
          label="OS sandbox"
          description="Wrap shell commands in an OS sandbox (bubblewrap on Linux) when available."
          htmlFor="sandbox"
        >
          <Toggle
            id="sandbox"
            checked={tools.sandbox}
            onChange={(v) => void patch({ tools: { ...tools, sandbox: v } })}
          />
        </Field>
        <Field
          label="Fail closed"
          description="In Auto mode, refuse commands when the sandbox is unavailable."
          htmlFor="fail-closed"
        >
          <Toggle
            id="fail-closed"
            checked={tools.failClosed}
            onChange={(v) => void patch({ tools: { ...tools, failClosed: v } })}
          />
        </Field>
      </Disclosure>
    </SectionShell>
  );
}
