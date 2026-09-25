/**
 * The workspace → repository mapping the extension host publishes for its MCP
 * server processes.
 *
 * Each window writes its own file
 * (`mcp-workspace-<extension-host-pid>-<per-window-nonce>.json` under the
 * extension's globalStorage; the nonce keeps a recycled pid in a newer window
 * from reading the stale file of its dead predecessor) and hands the path to
 * the MCP child through the spawn environment (`FORGEJO_MCP_STATE_FILE`), so
 * the shape is a private contract between the two halves of this extension —
 * but the reader must still tolerate a file written by a different version of
 * the writer (the host may have been reloaded onto a newer build while a
 * child from the previous one is still running). Fields this version no
 * longer knows (such as the dropped `remoteUrl`) are simply ignored there.
 *
 * The file never carries credentials: the instance URL has its userinfo
 * removed entirely.
 */
export interface McpWorkspaceStateRepository {
  /**
   * Id of the configured instance the repository is linked to. The child
   * matches this against its own `FORGEJO_MCP_INSTANCE_ID` before the URL, so
   * two accounts on the same host (two instances, one URL) stay apart.
   */
  instanceId: string;
  /**
   * Instance URL with credential userinfo removed entirely
   * (`stripUrlUserinfo`): the MCP child matches it against its own
   * `FORGEJO_MCP_INSTANCE_URL` when no instance id is available (a child
   * spawned by an older host), so it must be usable, not merely masked.
   */
  instanceUrl: string;
  owner: string;
  repo: string;
  /** Absolute path of the local checkout on the extension host. */
  localPath: string;
  /**
   * Best-effort marker for the repository the user's editor context is
   * attributed to. The writer only sets it when the attribution is
   * unambiguous — a single linked repository, or the active editor verifiably
   * inside the attributed one — so it may be false on every entry.
   */
  active: boolean;
}

export interface McpWorkspaceStateFile {
  /** ISO timestamp of the last write, for debugging staleness. */
  updatedAt: string;
  repositories: McpWorkspaceStateRepository[];
}
