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
   * never appears here — the consumer either forwards into the extension host's
   * broker (the normal case, where the host holds the token) or, with no broker
   * running, authenticates anonymously or through its own `FORGEJO_MCP_TOKEN`.
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

/**
 * The broker registration the extension host publishes as the fixed-name
 * `mcp-broker.json` next to the per-window state files in its globalStorage
 * directory (writer: src/mcpBroker.ts; consumer: mcp/brokerForwarder.ts).
 *
 * The broker is how an MCP server launched from a static `mcp.json` (the
 * Agents window's Agent Host) gets *authenticated* tools without a token ever
 * leaving the extension host: the launched process is a pure forwarder that
 * pipes its stdio to the broker over a local named pipe / unix socket, and the
 * real tool logic — with the token — runs inside the extension host process.
 *
 * Security model of the `authToken` field: it is a random per-broker-launch
 * secret, not a Forgejo token. It gates the pipe so that another process of
 * the same user (or, on a shared machine, another local process that can
 * guess the endpoint name) cannot make the extension host issue authenticated
 * requests on its behalf. The file lands in the same globalStorage directory
 * as the workspace state files and is written owner-only (0600, directory
 * 0700); the unix socket it points at is chmod 0600 as well. What the file
 * must *never* carry is the Forgejo token itself, and it does not: only this
 * broker-local handshake secret. A forwarded session proves "same local user
 * who can read globalStorage", nothing more — exactly the trust level the VS
 * Code-spawned path already grants its stdio children.
 *
 * Unlike the instance registry, this file is removed by `deactivate()`: it
 * describes a live listener owned by one window, not account configuration.
 * A crash-orphaned file is harmless — the forwarder's connect simply fails
 * and it falls back to the zero-configuration launch.
 */
export interface McpBrokerRegistryFile {
  /** Schema version, pinned at 1 so a newer writer is detectable. */
  version: 1;
  /**
   * Pid of the extension host process that owns the broker. Consumers use it
   * as a cheap staleness pre-filter (a verifiably dead pid marks a
   * crash-orphaned file) but still treat connect failure as the final
   * authority on liveness — pids get recycled.
   */
  pid: number;
  /**
   * Where the broker listens: a `\\.\pipe\…` name on Windows, a unix socket
   * path elsewhere. Contains no credentials.
   */
  endpoint: string;
  /**
   * The per-launch handshake secret (random hex, 64 chars). The forwarder
   * sends it as the first line of the connection; a mismatch disconnects the
   * session immediately. Never logged by either side.
   */
  authToken: string;
  /** ISO timestamp of the broker start, for debugging staleness. */
  startedAt: string;
}
