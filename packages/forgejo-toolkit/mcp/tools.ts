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

export interface ListActionRunsArgs extends RepoRefArgs {
  page?: number;
  limit?: number;
}

export interface ActionRunRefArgs extends RepoRefArgs {
  runId: number;
}

export interface ActionJobLogArgs extends RepoRefArgs {
  jobId: number;
}

export interface FileContentArgs extends RepoRefArgs {
  path: string;
  ref?: string;
}

export interface ListRepoContentsArgs extends RepoRefArgs {
  path?: string;
  ref?: string;
}

export interface ListCommitsArgs extends RepoRefArgs {
  branch?: string;
}

export interface SearchRepoFilesArgs extends RepoRefArgs {
  query: string;
  ref?: string;
}

export interface ReviewRefArgs extends IssueRefArgs {
  reviewId: number;
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
        default:
          // Exhaustive over the declared enum; the default keeps a forged or
          // future value from returning `undefined` as the tool result.
          throw new Error(`Unknown search type: ${String(args.type)}`);
      }
    },

    // Actions. The client gates these on the probed server version
    // (MIN_ACTIONS_VERSION); the error propagates to the tool layer as-is.
    list_action_runs: (args: ListActionRunsArgs) => client.listActionRuns(args.owner, args.repo, args.page, args.limit),

    get_action_run_jobs: (args: ActionRunRefArgs) => client.getActionRunJobs(args.owner, args.repo, args.runId),

    get_action_job_log: (args: ActionJobLogArgs) => client.getActionJobLog(args.owner, args.repo, args.jobId),

    get_action_run_artifacts: (args: ActionRunRefArgs) =>
      client.getActionRunArtifacts(args.owner, args.repo, args.runId),

    // Code reading.
    get_file_content: (args: FileContentArgs) => client.getFileContent(args.owner, args.repo, args.path, args.ref),

    list_repo_contents: (args: ListRepoContentsArgs) =>
      client.getRepoContents(args.owner, args.repo, args.path ?? '', args.ref),

    list_branches: (args: RepoRefArgs) => client.getRepoBranches(args.owner, args.repo),

    list_tags: (args: RepoRefArgs) => client.getRepoTags(args.owner, args.repo),

    list_commits: (args: ListCommitsArgs) => client.getRepoBranchCommits(args.owner, args.repo, args.branch),

    get_file_history: (args: FileContentArgs) => client.getFileHistory(args.owner, args.repo, args.path, args.ref),

    search_repo_files: async (args: SearchRepoFilesArgs) => {
      // The git-tree endpoint needs an explicit ref; resolve the default
      // branch when the caller omits one.
      const ref = args.ref ?? (await client.getRepoDefaultBranch(args.owner, args.repo));
      return client.searchRepoFiles(args.owner, args.repo, ref, args.query);
    },

    get_pr_diff: (args: IssueRefArgs) => client.getPullRequestDiff(args.owner, args.repo, args.index),

    // Reviews and metadata. get_pr_timeline already carries review comment
    // bodies, but not their file path / line position — that code location is
    // the point of an inline review comment, so a dedicated tool stays
    // warranted (the extension's own review controller relies on the same
    // endpoint for exactly this reason).
    get_pull_review_comments: (args: ReviewRefArgs) =>
      client.getPullReviewComments(args.owner, args.repo, args.index, args.reviewId),

    list_pull_reviews: (args: IssueRefArgs) => client.listPullReviews(args.owner, args.repo, args.index),

    whoami: () => client.getCurrentUser(),

    list_releases: (args: RepoRefArgs) => client.getRepoReleases(args.owner, args.repo),

    list_labels: (args: RepoRefArgs) => client.getRepoLabels(args.owner, args.repo),

    list_milestones: (args: RepoRefArgs) => client.getRepoMilestones(args.owner, args.repo),

    list_my_repos: () => client.getUserRepositories(),
  };
}

export type ToolName = keyof ReturnType<typeof buildToolHandlers>;

/**
 * A single owner/repository path segment supplied by the model.
 *
 * The generated API client interpolates path parameters verbatim into the
 * request path (`/repos/${owner}/${repo}/…`) and the URL parser resolves dot
 * segments and splits the path on `?`/`#`, so an unvalidated value can leave
 * the intended endpoint entirely — `repo: 'x/../../admin/users'` turns a
 * repository-scoped read into an arbitrary same-origin request. Forgejo's own
 * username and repository names contain none of the rejected characters, so
 * this only rules out values that could not name a repository anyway.
 */
export function isSafePathSegment(value: string): boolean {
  return (
    value.length > 0 &&
    value.trim() === value &&
    !/[/\\?#%]/.test(value) &&
    value !== '.' &&
    value !== '..' &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

/**
 * Control characters (C0 and C1) have no place in a URL path or a repository
 * name and would be silently dropped or rejected by the server; `\p{Cc}` is
 * used instead of a code-point range so the check stays lint-clean and also
 * covers the C1 block.
 */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/**
 * A repository-relative file path supplied by the model. Each segment is
 * URL-encoded by the client, but `..` survives encoding, so dot segments (and
 * empty ones, which the API treats as a different route) are rejected here.
 * The empty path is only acceptable where the API treats it as "repository
 * root" (see `allowEmpty`).
 */
export function isSafeRepoPath(value: string, options: { allowEmpty?: boolean } = {}): boolean {
  if (value === '') {
    return options.allowEmpty === true;
  }
  return (
    value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..') &&
    !value.includes('\\') &&
    !CONTROL_CHARACTER_PATTERN.test(value)
  );
}

function pathSegmentSchema(description: string) {
  return z
    .string()
    .refine(isSafePathSegment, {
      message: `${description} must be a single path segment (no '/', '\\', '?', '#', '%', control characters, or '.'/'..')`,
    })
    .describe(description);
}

function repoPathSchema(description: string, options: { allowEmpty?: boolean } = {}) {
  return z
    .string()
    .refine((value) => isSafeRepoPath(value, options), {
      message: `${description} must be a repository-relative path without empty, '.' or '..' segments, backslashes or control characters`,
    })
    .describe(description);
}

// Shared fields for the repository-scoped tools below. The owner/repo pair is
// optional for the two listing tools that fall back to the instance-wide user
// listing; every other repository-scoped tool requires both.
const ownerSchema = pathSegmentSchema('Repository owner (user or organization).')
  .optional()
  .describe('Repository owner (user or organization). Required together with repo for a repository listing.');
const repoSchema = pathSegmentSchema('Repository name.').optional().describe('Repository name.');
const stateSchema = z.enum(['open', 'closed', 'all']).optional().describe('State filter (default: open).');
const ownerRequiredSchema = pathSegmentSchema('Repository owner (user or organization).');
const repoRequiredSchema = pathSegmentSchema('Repository name.');
const pullIndexSchema = z.number().int().positive().describe('Pull request number.');
const refSchema = z
  .string()
  .optional()
  .describe('Branch, tag, or commit SHA (default: the repository default branch).');

/**
 * Whole-result budget. `MAX_TOOL_TEXT_LENGTH` bounds each individual string,
 * but a paginated list (the client caps lists at 500 items) can still serialize
 * to megabytes across many fields, which would blow up the agent's context
 * window. The serialized result is therefore capped as a whole and the cut is
 * announced, so the agent can tell a complete answer from a truncated one.
 */
export const MAX_TOOL_RESULT_LENGTH = 64 * 1024;

/** Wraps a handler run into an MCP tool result: truncation + error rendering. */
async function callTool(run: () => Promise<unknown>) {
  try {
    const result = truncateLargeStrings(await run());
    const serialized = JSON.stringify(result, null, 2) ?? 'null';
    const text =
      serialized.length > MAX_TOOL_RESULT_LENGTH
        ? `${serialized.slice(0, MAX_TOOL_RESULT_LENGTH)}\n... (truncated: the result exceeded ${Math.round(MAX_TOOL_RESULT_LENGTH / 1024)} KB and was cut off)`
        : serialized;
    return { content: [{ type: 'text' as const, text }] };
  } catch (error) {
    // userFacingErrorMessage never includes request headers, so the token
    // cannot leak into tool output.
    return { isError: true, content: [{ type: 'text' as const, text: userFacingErrorMessage(error) }] };
  }
}

/**
 * Read-only tool surface over the paginated client methods (which carry their
 * own MAX_ITEMS caps). Tool names and descriptions are English literals on
 * purpose — they are read by LLM agents, not by users.
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

  server.registerTool(
    'list_action_runs',
    {
      description: 'List Forgejo Actions workflow runs of a repository (requires a server with the Actions API).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        page: z.number().int().positive().optional().describe('Page number (default: 1).'),
        limit: z.number().int().positive().max(100).optional().describe('Runs per page (default: 30).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_action_runs(args)),
  );

  server.registerTool(
    'get_action_run_jobs',
    {
      description: 'List the jobs of an Actions workflow run, with their status.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        runId: z.number().int().positive().describe('Workflow run ID.'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_action_run_jobs(args)),
  );

  server.registerTool(
    'get_action_job_log',
    {
      description:
        'Get the raw log of an Actions job as a single string. Large logs are truncated to ~10 KB by the tool result budget.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        jobId: z.number().int().positive().describe('Job ID (from get_action_run_jobs).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_action_job_log(args)),
  );

  server.registerTool(
    'get_action_run_artifacts',
    {
      description: 'List the artifacts of an Actions workflow run (metadata and download URLs, not contents).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        runId: z.number().int().positive().describe('Workflow run ID.'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_action_run_artifacts(args)),
  );

  server.registerTool(
    'get_file_content',
    {
      description:
        'Get the decoded text content of a file in a repository. Large files are truncated to ~10 KB by the tool result budget.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        path: repoPathSchema('File path within the repository.'),
        ref: refSchema,
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_file_content(args)),
  );

  server.registerTool(
    'list_repo_contents',
    {
      description: 'List files and directories at a path in a repository (default: repository root).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        path: repoPathSchema('Directory path within the repository (default: root).', { allowEmpty: true }).optional(),
        ref: refSchema,
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_repo_contents(args)),
  );

  server.registerTool(
    'list_branches',
    {
      description: 'List the branches of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_branches(args)),
  );

  server.registerTool(
    'list_tags',
    {
      description: 'List the tags of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_tags(args)),
  );

  server.registerTool(
    'list_commits',
    {
      description: 'List the latest commits of a branch (up to 10).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        branch: z.string().optional().describe('Branch name (default: the repository default branch).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_commits(args)),
  );

  server.registerTool(
    'get_file_history',
    {
      description: 'List the commits that touched a file (up to 50).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        path: repoPathSchema('File path within the repository.'),
        ref: refSchema,
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_file_history(args)),
  );

  server.registerTool(
    'search_repo_files',
    {
      description: 'Search file paths in a repository by keyword (case-insensitive substring match over the git tree).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        query: z.string().describe('Keyword to match against file paths.'),
        ref: refSchema,
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.search_repo_files(args)),
  );

  server.registerTool(
    'get_pr_diff',
    {
      description:
        'Get the full unified diff of a pull request as a single string. Large diffs are truncated to ~10 KB by the tool result budget.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: pullIndexSchema,
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_pr_diff(args)),
  );

  server.registerTool(
    'get_pull_review_comments',
    {
      description:
        'List the inline code comments of a pull request review, with file path and line position. Use list_pull_reviews to find review IDs.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: pullIndexSchema,
        reviewId: z.number().int().positive().describe('Review ID (from list_pull_reviews).'),
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.get_pull_review_comments(args)),
  );

  server.registerTool(
    'list_pull_reviews',
    {
      description: 'List the reviews of a pull request with their conclusions (APPROVED, CHANGES_REQUESTED, etc.).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: pullIndexSchema,
      },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_pull_reviews(args)),
  );

  server.registerTool(
    'whoami',
    {
      description: 'Get the authenticated user the configured token belongs to.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => callTool(() => handlers.whoami()),
  );

  server.registerTool(
    'list_releases',
    {
      description: 'List the releases of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_releases(args)),
  );

  server.registerTool(
    'list_labels',
    {
      description: 'List the labels of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_labels(args)),
  );

  server.registerTool(
    'list_milestones',
    {
      description: 'List the open milestones of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args) => callTool(() => handlers.list_milestones(args)),
  );

  server.registerTool(
    'list_my_repos',
    {
      description: 'List the repositories of the authenticated user (owned and collaborated).',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => callTool(() => handlers.list_my_repos()),
  );
}
