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
      description="Gate what the agent may run. Read tools never prompt; shell, edits, web, and MCP calls are gated."
    >
      <FieldGroup>
        <Field
          label="Mode"
          description="Controls tool access and when the agent asks for approval. Also switchable from the composer."
        >
          <select
            value={tools.mode}
            onChange={(e) => void patch({ tools: { ...tools, mode: asToolsMode(e.target.value) } })}
            className={selectCls}
          >
            <option value="off">Off — no file or shell tools</option>
            <option value="read-only">Read-only — read/glob/search</option>
            <option value="ask">Ask — every gated tool prompts</option>
            <option value="auto">Auto — safe tools run without prompts</option>
          </select>
        </Field>

        <Field
          label="Auto-approve safe shell"
          description="In Auto mode, run known read-only commands (ls, cat, git status, …) without a prompt."
          htmlFor="auto-safe-bash"
        >
          <Toggle
            id="auto-safe-bash"
            checked={tools.autoApprove.safeBash}
            onChange={(v) =>
              void patch({
                tools: { ...tools, autoApprove: { ...tools.autoApprove, safeBash: v } }
              })
            }
          />
        </Field>
        <Field
          label="Auto-approve web"
          description="In Auto mode, run web search and web fetch without a prompt."
          htmlFor="auto-web"
        >
          <Toggle
            id="auto-web"
            checked={tools.autoApprove.web}
            onChange={(v) =>
              void patch({ tools: { ...tools, autoApprove: { ...tools.autoApprove, web: v } } })
            }
          />
        </Field>
        <Field
          label="Auto-approve edits"
          description="In Auto mode, apply file writes confined to the workspace without a prompt."
          htmlFor="auto-edits"
        >
          <Toggle
            id="auto-edits"
            checked={tools.autoApprove.edits}
            onChange={(v) =>
              void patch({ tools: { ...tools, autoApprove: { ...tools.autoApprove, edits: v } } })
            }
          />
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
