# Read agents and the builder could not research

On 2026-11-02, with Claude Code 2.1.316 and Pi 1.5.0.

## What happened

The builder pane and `access = "read"` agents in stage files used the `locked` flags.
Those flags remove Bash, WebSearch, WebFetch and ToolSearch from Claude Code, and `--strict-mcp-config` turns off every MCP server.
On Pi, the `--tools read,grep,find,ls,fleet_*` allowlist drops extension tools, and `--exclude-tools mcp__*` drops MCP.
So a person who asked the builder to research best practices got an agent with no way to search.

## Fix

A new `research` mode keeps every tool except the edit tools.
The builder and read agents use it.
A locked run, from a stranger's PR or issue, and a Pi plan agent before approval keep the `locked` flags.

| Program     | Flags                                                                   |
| ----------- | ----------------------------------------------------------------------- |
| Claude Code | `--disallowedTools Edit Write NotebookEdit`                             |
| Pi          | `--no-approve --tools +bash,+grep,+find,+ls --exclude-tools edit,write` |

## Checked by hand

- `claude -p --disallowedTools Edit Write NotebookEdit` lists Bash, WebSearch, WebFetch, ToolSearch, Skill, Agent and the user's MCP tools, with no Edit or Write.
- A subagent that this agent starts has no Edit or Write either.
- Pi with the research flags lists read, bash, grep, find, ls and the `fleet_*` extension tools, with no edit or write.
- In the dev app, a Claude Code builder pane ran Web Search and listed the person's MCP servers.

## Traps

**`--disallowedTools` takes many values, like `--add-dir`.**
Put it before another flag, or it eats the message.
`claudeArgs` puts it before `--append-system-prompt-file`.

**Pi `+` entries matter on resume.**
A full `--tools` list, or no `--tools`, makes a resumed Pi take back the read-only list from an older session.
Naming the tools with `+` keeps the research tools.

**"Read" is no longer a hard limit.**
Bash can write files, so a read agent is kept from edits by its brief and by normal permissions, not by its tools.
Claude Code asks before a Bash or MCP call that the person has not allowed, so a run shows Needs you.
Pi has no approval step.
