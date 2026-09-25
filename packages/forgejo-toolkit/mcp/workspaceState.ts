import * as fs from 'fs';
import * as path from 'path';
import type { McpWorkspaceStateRepository } from '@cpf23333-forgejo-toolkit/shared/mcp/workspaceState';
import { stripUrlUserinfo } from '../src/utils/redactUrlUserinfo';

/**
 * Reader half of the workspace → repository mapping (writer:
 * src/mcpWorkspaceState.ts). This module is bundled into the headless MCP
 * server, so it must stay free of `vscode` imports, and its messages are
 * English literals on purpose — they are read by LLM agents, not by users.
 */

/** A matched repository as the tool reports it. */
export interface WorkspaceRepositoryMatch {
  owner: string;
  repo: string;
  localPath: string;
  /** True for the repository the user's editor context is attributed to. */
  active: boolean;
}

/** The repositories of one *other* configured instance, for the no-match answer. */
export interface OtherInstanceRepositories {
  instanceUrl: string;
  repositories: { owner: string; repo: string; localPath: string }[];
}

export type WorkspaceRepositoryResult =
  | { status: 'not_configured'; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'empty'; message: string }
  | { status: 'matched'; repositories: WorkspaceRepositoryMatch[] }
  | { status: 'other_instances'; message: string; otherInstances: OtherInstanceRepositories[] };

/**
 * The comparison form for instance URLs: userinfo removed (the state file is
 * written stripped, while this process's own FORGEJO_MCP_INSTANCE_URL is the
 * configured value verbatim, credentials included) and trailing slashes
 * dropped, so `https://host/` and `https://host` name the same instance.
 */
function normalizeInstanceUrl(url: string): string {
  return stripUrlUserinfo(url).replace(/\/+$/, '');
}

/**
 * The repositories of a parsed state file, or undefined when the value is not
 * a state file at all.
 *
 * Entries that fail the field check are skipped rather than failing the whole
 * read: the writer and this reader can be on different extension versions
 * (the host may have reloaded onto a newer build while this child keeps
 * running), and an entry this version does not understand must not hide the
 * ones it does.
 */
function readRepositories(parsed: unknown): McpWorkspaceStateRepository[] | undefined {
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }
  // Read as `unknown` all the way down: the bytes come from a file another
  // build may have written, so the shared type is documentation here, not
  // something to assert.
  const list = (parsed as { repositories?: unknown }).repositories;
  if (!Array.isArray(list)) {
    return undefined;
  }
  const repositories: McpWorkspaceStateRepository[] = [];
  for (const entry of list as unknown[]) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (
      typeof candidate.instanceUrl === 'string' &&
      typeof candidate.owner === 'string' &&
      typeof candidate.repo === 'string' &&
      typeof candidate.localPath === 'string'
    ) {
      // Fields this version no longer knows (a legacy file's `remoteUrl`,
      // say) are simply not read — the entry-level check above is what keeps
      // a foreign entry out.
      repositories.push({
        instanceId: typeof candidate.instanceId === 'string' ? candidate.instanceId : '',
        instanceUrl: candidate.instanceUrl,
        owner: candidate.owner,
        repo: candidate.repo,
        localPath: candidate.localPath,
        active: candidate.active === true,
      });
    }
  }
  return repositories;
}

const UNAVAILABLE: WorkspaceRepositoryResult = {
  status: 'unavailable',
  message:
    'No workspace repository information is available: the extension host has not published a readable state file. Ask the user for the repository owner and name.',
};

/**
 * The state file path arrives through this process's own environment — which
 * the extension host wrote, but a hand-edited MCP configuration or an
 * external launcher can carry anything. Only the names this extension itself
 * produces are read; anything else is treated as "not configured" rather than
 * reading a file that was never meant for this tool.
 */
const STATE_FILE_BASENAME = /^mcp-workspace-.+\.json$/;

/**
 * Upper bound for a file this process will parse. The writer publishes a
 * handful of workspace repositories, so anything near a megabyte is not a
 * state file this version wrote — refuse it instead of spending the memory.
 */
const MAX_STATE_FILE_BYTES = 1024 * 1024;

/**
 * Answers "which repository is the user working in?" for the
 * `get_workspace_repository` tool.
 *
 * The state file is re-read on every call — never cached — because the
 * workspace changes while this long-lived process runs (folders opened, the
 * active editor switched, instances added). A missing or unreadable file is
 * an ordinary answer, not an error: the workspace simply may not be linked to
 * any Forgejo repository, and the agent still needs a usable reply.
 *
 * Only repositories of *this* process's instance are returned as matches;
 * repositories linked to other configured instances are reported by instance
 * URL, so the agent knows to use the MCP server of that instance instead.
 */
export async function resolveWorkspaceRepository(
  stateFile: string | undefined,
  instanceUrl: string | undefined,
  ownInstanceId?: string,
): Promise<WorkspaceRepositoryResult> {
  if (!stateFile) {
    return {
      status: 'not_configured',
      message:
        'This MCP server was not launched with workspace information (FORGEJO_MCP_STATE_FILE is not set). Ask the user for the repository owner and name.',
    };
  }
  if (!STATE_FILE_BASENAME.test(path.basename(stateFile))) {
    return {
      status: 'not_configured',
      message: `The configured state file path does not name a workspace state file (expected a mcp-workspace-*.json name, got "${path.basename(stateFile)}"). Ask the user for the repository owner and name.`,
    };
  }
  let raw: string;
  try {
    // stat before reading: a wildly oversized file is refused on its size
    // alone, without paying for the read.
    const stats = await fs.promises.stat(stateFile);
    if (stats.size > MAX_STATE_FILE_BYTES) {
      return {
        status: 'unavailable',
        message: `The workspace state file is ${stats.size} bytes, far larger than any state file the extension writes. Refusing to read it; ask the user for the repository owner and name.`,
      };
    }
    raw = await fs.promises.readFile(stateFile, 'utf8');
  } catch {
    return UNAVAILABLE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A torn write should not be possible (the host writes atomically), so a
    // parse failure means the file is genuinely not a state file.
    return UNAVAILABLE;
  }
  const repositories = readRepositories(parsed);
  if (!repositories) {
    return UNAVAILABLE;
  }
  if (repositories.length === 0) {
    return {
      status: 'empty',
      message:
        'The workspace has no repository linked to this or any other configured Forgejo instance. Ask the user for the repository owner and name.',
    };
  }
  const ownInstance = instanceUrl ? normalizeInstanceUrl(instanceUrl) : undefined;
  // Two instances can share one host URL (two accounts, two tokens); a URL
  // match alone would hand both servers the same repositories. The instance
  // id is the precise key, but only hosts new enough to publish it set
  // FORGEJO_MCP_INSTANCE_ID — when it is absent (a child spawned by an older
  // host build), fall back to the URL comparison and accept the ambiguity
  // that comparison cannot resolve.
  const matched = ownInstanceId
    ? repositories.filter((entry) => entry.instanceId === ownInstanceId)
    : ownInstance
      ? repositories.filter((entry) => normalizeInstanceUrl(entry.instanceUrl) === ownInstance)
      : [];
  if (matched.length > 0) {
    return {
      status: 'matched',
      repositories: matched.map((entry) => ({
        owner: entry.owner,
        repo: entry.repo,
        localPath: entry.localPath,
        active: entry.active,
      })),
    };
  }
  // Grouped by instance so the agent can see which *other* MCP server (one is
  // registered per configured instance) serves each workspace repository.
  const byInstance = new Map<string, OtherInstanceRepositories>();
  for (const entry of repositories) {
    let group = byInstance.get(entry.instanceUrl);
    if (!group) {
      group = { instanceUrl: entry.instanceUrl, repositories: [] };
      byInstance.set(entry.instanceUrl, group);
    }
    group.repositories.push({ owner: entry.owner, repo: entry.repo, localPath: entry.localPath });
  }
  const otherInstances = [...byInstance.values()];
  return {
    status: 'other_instances',
    message: `The workspace repositories belong to other configured Forgejo instances (${otherInstances
      .map((group) => group.instanceUrl)
      .join(
        ', ',
      )}), not to the instance this MCP server is connected to. Use the MCP server of the matching instance, or ask the user for the repository owner and name.`,
    otherInstances,
  };
}
