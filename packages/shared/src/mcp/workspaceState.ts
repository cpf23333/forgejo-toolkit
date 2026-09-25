/**
 * The workspace → repository mapping the extension host publishes for its MCP
 * server processes.
 *
 * Each window writes its own file (`mcp-workspace-<extension-host-pid>.json`
 * under the extension's globalStorage) and hands the path to the MCP child
 * through the spawn environment (`FORGEJO_MCP_STATE_FILE`), so the shape is a
 * private contract between the two halves of this extension — but the reader
 * must still tolerate a file written by a different version of the writer
 * (the host may have been reloaded onto a newer build while a child from the
 * previous one is still running).
 *
 * The file never carries credentials: the instance URL has its userinfo
 * removed entirely and the remote URL is the display-redacted value detection
 * already produced.
 */
export interface McpWorkspaceStateRepository {
  /** Id of the configured instance the repository is linked to. */
  instanceId: string;
  /**
   * Instance URL with credential userinfo removed entirely
   * (`stripUrlUserinfo`): the MCP child matches it against its own
   * `FORGEJO_MCP_INSTANCE_URL`, so it must be usable, not merely masked.
   */
  instanceUrl: string;
  owner: string;
  repo: string;
  /** Absolute path of the local checkout on the extension host. */
  localPath: string;
  /** The remote the link was detected through, credentials masked. */
  remoteUrl: string;
  /**
   * True for the one repository the current editor context is attributed to
   * (the active editor's repository); every window has at most one.
   */
  active: boolean;
}

export interface McpWorkspaceStateFile {
  /** ISO timestamp of the last write, for debugging staleness. */
  updatedAt: string;
  repositories: McpWorkspaceStateRepository[];
}
