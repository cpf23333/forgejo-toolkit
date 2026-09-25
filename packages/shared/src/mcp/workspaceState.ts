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

/**
 * One configured instance as the instance registry publishes it.
 *
 * The registry exists so an MCP server launched outside VS Code's own spawn
 * path (a static workspace `.mcp.json` carries only `command` + `args`, no
 * per-instance environment) can still discover which instances exist and pick
 * one by matching the working directory's git remote. It is the only
 * configuration such a process can see: the extension's instance list lives in
 * the editor's state database and its tokens in SecretStorage/keychain, both
 * of which are deliberately not read by the MCP process (the database schema
 * is an internal that changes between versions, and touching the OS keychain
 * from a headless child would trip the OS credential prompt — see
 * mcp/autoConfig.ts, which consumes this file).
 */
export interface McpInstanceRegistryEntry {
  /** Id of the configured instance, so a consumer can tell two accounts on one host apart. */
  id: string;
  /**
   * Instance URL with credential userinfo removed entirely
   * (`stripUrlUserinfo`): the file must never carry credentials, and a token
   * never appears here — the consumer authenticates anonymously or through its
   * own `FORGEJO_MCP_TOKEN`.
   */
  url: string;
  /** Display name of the instance, for messages that name the match. */
  name: string;
}

/**
 * The fixed-name `mcp-instances.json` the extension host writes next to the
 * per-window state files in its globalStorage directory.
 *
 * Unlike the state files it describes account configuration, not window
 * state, so it is shared by every window and survives restarts: `deactivate()`
 * does not delete it, and an emptied instance list is written as an empty
 * array rather than removing the file. Several windows write the same fixed
 * name concurrently — they all derive the content from the same shared
 * configuration, and each write is atomic (write-through-temp + rename), so a
 * reader only ever sees one complete snapshot.
 */
export interface McpInstanceRegistryFile {
  /** ISO timestamp of the last write, for debugging staleness. */
  updatedAt: string;
  instances: McpInstanceRegistryEntry[];
}
