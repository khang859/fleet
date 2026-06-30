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
          label="Max tool rounds"
          description="How many model⇄tool back-and-forth rounds one reply may take before stopping. Each round can run several tools, so this caps iterations, not individual tool calls. Raise it for deep multi-step work."
        >
          <input
            type="number"
            min={1}
            max={100}
            step={1}
            value={tools.maxToolRounds}
            onChange={(e) =>
              void patch({
                tools: {
                  ...tools,
                  maxToolRounds: Math.min(100, Math.max(1, Math.round(Number(e.target.value) || 1)))
                }
              })
            }
            className={`${inputCls} w-28`}
          />
        </Field>
        <Field
          label="Workspace directory"
          description="Absolute path the tools read, write, and run in. Leave empty to give each chat its own isolated folder under ~/.fleet/chat."
          layout="stack"
        >
          <input
            value={tools.workspaceDir ?? ''}
            placeholder="Default: isolated per-chat folder"
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
