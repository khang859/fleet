import type {
  McpImportScope,
  McpImportSource,
  McpServerConfig
} from '../../../../shared/agent-mcp';

/** One server as it stands in another tool's config file, already normalised. */
export type FoundServer = {
  name: string;
  config: McpServerConfig;
  source: McpImportSource;
  scope: McpImportScope;
  /** Absolute path of the file it came from, so the UI can point at it. */
  path: string;
};

/** Where a scan looks. Injected so tests can point it at a fixture directory. */
export type ScanPaths = {
  /** The user's home directory. */
  home: string;
  /** The folder the agent is working in, which is what "project scope" means. */
  cwd: string;
};
