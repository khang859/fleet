# OpenRouter documentation review tooling

During the OpenRouter integration review, `ego-browser` failed in the managed sandbox with `Failed to connect to ego_cli bootstrap` and macOS XPC connection errors. The tool's diagnostic identified sandbox access as the cause. After reading the browser skill's setup guidance, the same read-only command succeeded with approved execution outside the sandbox. No browser installation or Fleet change was needed.

A source read also assumed an MCP `snapshot.ts` module existed; it did not. Listing the directory with `rg --files src/main/agent/mcp` identified `manager.ts` as the owner of `getToolSpecs()`. Discover filenames before composing dependent reads.

The live OpenRouter feature guide and Chat API schema use different server-tool usage field names (`server_tool_use` versus `server_tool_use_details`). The Chat schema also documents `reasoning.server_tool_call` history records. Any implementation should capture real endpoint-specific streaming fixtures and preserve replay metadata instead of copying only a feature-guide example.
