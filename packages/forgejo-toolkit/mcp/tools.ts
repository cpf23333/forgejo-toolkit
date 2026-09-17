import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ForgejoClient } from '../src/api/client';
import { userFacingErrorMessage } from '../src/api/errors-core';

/**
 * Per-field size budget for tool results: issue/PR bodies, comment text and
 * diffs can be arbitrarily large, and a runaway payload would both blow up
 * the agent's context window and exfiltrate repository content through an
 * unexpected channel. Any single string field is capped at ~10 KB.
 */
export const MAX_TOOL_TEXT_LENGTH = 10 * 1024;

/** Deep-copies a JSON-shaped value, truncating every oversized string field. */
export function truncateLargeStrings<T>(value: T, maxLength: number = MAX_TOOL_TEXT_LENGTH): T {
  if (typeof value === 'string') {
    return value.length > maxLength
      ? (`${value.slice(0, maxLength)}\n... (truncated: ${value.length - maxLength} more characters)` as T)
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateLargeStrings(item, maxLength)) as T;
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      result[key] = truncateLargeStrings(item, maxLength);
    }
    return result as T;
  }
  return value;
}

type IssueState = 'open' | 'closed' | 'all';
type NotificationStatus = 'unread' | 'read' | 'pinned';

export interface ListIssuesArgs {
  owner?: string;
  repo?: string;
  state?: IssueState;
  query?: string;
}

export interface RepoRefArgs {
  owner: string;
  repo: string;
}

export interface IssueRefArgs extends RepoRefArgs {
  index: number;
}

export interface ListNotificationsArgs {
  statusTypes?: NotificationStatus[];
  limit?: number;
}

export interface SearchArgs {
  query: string;
  type: 'issues' | 'pull_requests' | 'repositories';
  state?: IssueState;
  limit?: number;
}

/**
 * Plain async handlers behind the MCP tools, exported for unit tests: they
 * return the untruncated payload and let errors propagate. The MCP
 * registration (registerTools) adds truncation and error rendering on top.
 */
export function buildToolHandlers(client: ForgejoClient) {
  return {
    list_issues: (args: ListIssuesArgs) =>
      args.owner && args.repo
        ? client.getRepoIssues(args.owner, args.repo, args.state ?? 'open', args.query)
        : client.getUserIssues(args.state ?? 'open'),

    get_issue: async (args: IssueRefArgs) => {
      // The timeline endpoint is shared between issues and PRs; the client
      // method is named after its PR usage but serves issue comments too.
      const [issue, comments] = await Promise.all([
        client.getIssueDetail(args.owner, args.repo, args.index),
        client.getPullRequestCommentsAndTimeline(args.owner, args.repo, args.index),
      ]);
      return { issue, comments };
    },

    list_pull_requests: (args: ListIssuesArgs) =>
      args.owner && args.repo
        ? client.getRepoPullRequests(args.owner, args.repo, args.state ?? 'open', args.query)
        : client.getUserPullRequests(args.state ?? 'open'),

    get_pull_request: async (args: IssueRefArgs) => {
      const [pullRequest, files, commits] = await Promise.all([
        client.getPullRequestDetail(args.owner, args.repo, args.index),
        client.getPullRequestFiles(args.owner, args.repo, args.index),
        client.getPullRequestCommits(args.owner, args.repo, args.index),
      ]);
      return { pullRequest, files, commits };
    },

    get_pr_timeline: (args: IssueRefArgs) =>
      client.getPullRequestCommentsAndTimeline(args.owner, args.repo, args.index),

    list_notifications: (args: ListNotificationsArgs) =>
      client.getNotifications(args.statusTypes ?? ['unread', 'pinned'], undefined, args.limit ?? 50),

    get_repo: (args: RepoRefArgs) => client.getRepoDetail(args.owner, args.repo),

    search: (args: SearchArgs) => {
      switch (args.type) {
        case 'issues':
          return client.searchIssues(args.query, args.state ?? 'open', args.limit ?? 20);
        case 'pull_requests':
          return client.searchPullRequests(args.query, args.state ?? 'open', args.limit ?? 20);
        case 'repositories':
          return client.searchRepositories(args.query, args.limit ?? 20);
      }
    },
  };
}

export type ToolName = keyof ReturnType<typeof buildToolHandlers>;

const ownerSchema = z
  .string()
  .optional()
  .describe('Repository owner (user or organization). Required together with repo for a repository listing.');
const repoSchema = z.string().optional().describe('Repository name.');
const stateSchema = z.enum(['open', 'closed', 'all']).optional().describe('State filter (default: open).');

/** Wraps a handler run into an MCP tool result: truncation + error rendering. */
async function callTool(run: () => Promise<unknown>) {
  try {
    const result = truncateLargeStrings(await run());
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    // userFacingErrorMessage never includes request headers, so the token
    // cannot leak into tool output.
    return { isError: true, content: [{ type: 'text' as const, text: userFacingErrorMessage(error) }] };
  }
}

/**
 * Phase 1 tool surface: read-only tools over the paginated client methods
 * (which carry their own MAX_ITEMS caps). Tool names and descriptions are
 * English literals on purpose — they are read by LLM agents, not by users.
 */
export function registerTools(server: McpServer, client: ForgejoClient): void {
  const handlers = buildToolHandlers(client);
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    'list_issues',
    {
      description:
        'List issues. With owner and repo, lists the issues of that repository (optionally keyword-filtered); without them, lists issues across the instance that involve the authenticated user.',
      inputSchema: {
        owner: ownerSchema,
        repo: repoSchema,
        state: stateSchema,
        query: z.string().optional().describe('Keyword filter (repository listing only).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_issues(args)),
  );

  server.registerTool(
    'get_issue',
    {
      description: 'Get a single issue by number, including its comments.',
      inputSchema: {
        owner: z.string().describe('Repository owner (user or organization).'),
        repo: z.string().describe('Repository name.'),
        index: z.number().int().positive().describe('Issue number.'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_issue(args)),
  );

  server.registerTool(
    'list_pull_requests',
    {
      description:
        'List pull requests. With owner and repo, lists the pull requests of that repository (optionally keyword-filtered); without them, lists pull requests across the instance that involve the authenticated user.',
      inputSchema: {
        owner: ownerSchema,
        repo: repoSchema,
        state: stateSchema,
        query: z.string().optional().describe('Keyword filter (repository listing only).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_pull_requests(args)),
  );

  server.registerTool(
    'get_pull_request',
    {
      description:
        'Get a single pull request by number, including changed files, commits, merge blockers, and status checks.',
      inputSchema: {
        owner: z.string().describe('Repository owner (user or organization).'),
        repo: z.string().describe('Repository name.'),
        index: z.number().int().positive().describe('Pull request number.'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_pull_request(args)),
  );

  server.registerTool(
    'get_pr_timeline',
    {
      description: 'Get the comment and event timeline of a pull request (review comments, status changes, etc.).',
      inputSchema: {
        owner: z.string().describe('Repository owner (user or organization).'),
        repo: z.string().describe('Repository name.'),
        index: z.number().int().positive().describe('Pull request number.'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_pr_timeline(args)),
  );

  server.registerTool(
    'list_notifications',
    {
      description: 'List Forgejo notifications for the authenticated user.',
      inputSchema: {
        statusTypes: z
          .array(z.enum(['unread', 'read', 'pinned']))
          .optional()
          .describe("Status filter (default: ['unread', 'pinned'])."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe('Maximum number of notifications (default: 50).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_notifications(args)),
  );

  server.registerTool(
    'get_repo',
    {
      description: 'Get repository details, including README, branches, and recent commits.',
      inputSchema: {
        owner: z.string().describe('Repository owner (user or organization).'),
        repo: z.string().describe('Repository name.'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_repo(args)),
  );

  server.registerTool(
    'search',
    {
      description: 'Search issues, pull requests, or repositories across the instance.',
      inputSchema: {
        query: z.string().describe('Search keywords.'),
        type: z.enum(['issues', 'pull_requests', 'repositories']).describe('What to search.'),
        state: stateSchema,
        limit: z.number().int().positive().max(50).optional().describe('Maximum number of results (default: 20).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.search(args)),
  );
}
