import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LIST_ITEM_LIMIT, MAX_SEARCH_RESULTS, REPO_DETAIL_LIST_LIMIT, type ForgejoClient } from '../src/api/client';
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
 * `owner` and `repo` are both optional on the list tools, and without them the
 * handler answers the wider "everything involving me" question. A caller that
 * supplies only one of the two is asking about a repository, so falling back to
 * the user-wide listing would silently answer a different question; it is
 * refused instead.
 */
function assertCompleteRepoScope(owner?: string, repo?: string): void {
  if ((owner && !repo) || (!owner && repo)) {
    throw new Error('owner and repo must be provided together (or both omitted for the instance-wide listing)');
  }
}

/**
 * The fields a keyword filter matches, mirroring the repository-scoped listing
 * endpoint (`/repos/{owner}/{repo}/issues?q=…`): title, body and author.
 */
function matchesQuery(
  item: { title?: string; body?: string; user?: { login?: string } },
  normalizedQuery: string,
): boolean {
  return [item.title, item.body, item.user?.login].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(normalizedQuery),
  );
}

/**
 * Client-side keyword filter for the instance-wide issue and pull request
 * listings.
 *
 * The repository-scoped branch asks the server to filter (`?q=`); the
 * instance-wide search endpoint the client uses for its fallback has no usable
 * keyword parameter here, so the argument has to be applied to the fetched rows.
 * Doing that is the point: the previous code dropped `query` entirely on that
 * branch, so a caller asking for `{ query: 'login' }` received every issue
 * involving the user and had no way to see that no filtering had happened.
 */
function filterByQuery<T extends { title?: string; body?: string; user?: { login?: string } }>(
  items: T[],
  query?: string,
): T[] {
  const normalized = query?.trim().toLowerCase();
  return normalized ? items.filter((item) => matchesQuery(item, normalized)) : items;
}

/**
 * Plain async handlers behind the MCP tools, exported for unit tests: they
 * return the untruncated payload and let errors propagate. The MCP
 * registration (registerTools) adds truncation and error rendering on top.
 */
export function buildToolHandlers(client: ForgejoClient) {
  return {
    // The scope assertion stays in a synchronous arrow so a half-specified
    // scope throws (rather than rejecting) before any request is issued; the
    // keyword filter is then applied to whatever the listing returns.
    list_issues: (args: ListIssuesArgs) => {
      assertCompleteRepoScope(args.owner, args.repo);
      const issues =
        args.owner && args.repo
          ? client.getRepoIssues(args.owner, args.repo, args.state ?? 'open', args.query)
          : client.getUserIssues(args.state ?? 'open');
      return issues.then((items) => filterByQuery(items, args.query));
    },

    get_issue: async (args: IssueRefArgs) => {
      // The timeline endpoint is shared between issues and PRs; the client
      // method is named after its PR usage but serves issue comments too.
      const [issue, comments] = await Promise.all([
        client.getIssueDetail(args.owner, args.repo, args.index),
        client.getPullRequestCommentsAndTimeline(args.owner, args.repo, args.index),
      ]);
      return { issue, comments };
    },

    list_pull_requests: (args: ListIssuesArgs) => {
      assertCompleteRepoScope(args.owner, args.repo);
      const pulls =
        args.owner && args.repo
          ? client.getRepoPullRequests(args.owner, args.repo, args.state ?? 'open', args.query)
          : client.getUserPullRequests(args.state ?? 'open');
      return pulls.then((items) => filterByQuery(items, args.query));
    },

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

/** Name used by `PAGED_LISTS` for a tool whose whole result is a paged list. */
const RESULT_FIELD = 'the result';
/** The whole tool result is a list the client fills by paging. */
const PAGED_RESULT = [RESULT_FIELD] as const;
/** No list in the tool result is paged, so nothing in it can have been cut off. */
const NO_PAGED_LISTS: readonly string[] = [];

/**
 * Per tool, the payload lists that come from a client method that pages until
 * `LIST_ITEM_LIMIT` (and therefore may be cut off).
 *
 * Length alone cannot decide this: several tools return a list read in a single
 * request — `list_repo_contents` lists a whole directory, `list_commits` asks
 * for 10, `search_repo_files` applies its own cap and reports `truncated` — and
 * a complete one of those that happens to hold `LIST_ITEM_LIMIT` rows must not
 * be announced as truncated. Every tool is listed explicitly so a new one is a
 * compile error until its lists have been classified.
 */
const PAGED_LISTS: Record<ToolName, readonly string[]> = {
  list_issues: PAGED_RESULT,
  get_issue: ['comments'],
  list_pull_requests: PAGED_RESULT,
  get_pull_request: ['files', 'commits'],
  get_pr_timeline: PAGED_RESULT,
  list_notifications: NO_PAGED_LISTS,
  get_repo: NO_PAGED_LISTS,
  search: NO_PAGED_LISTS,
  list_action_runs: NO_PAGED_LISTS,
  get_action_run_jobs: NO_PAGED_LISTS,
  get_action_job_log: NO_PAGED_LISTS,
  get_action_run_artifacts: PAGED_RESULT,
  get_file_content: NO_PAGED_LISTS,
  list_repo_contents: NO_PAGED_LISTS,
  list_branches: PAGED_RESULT,
  list_tags: PAGED_RESULT,
  list_commits: NO_PAGED_LISTS,
  get_file_history: NO_PAGED_LISTS,
  search_repo_files: NO_PAGED_LISTS,
  get_pr_diff: NO_PAGED_LISTS,
  get_pull_review_comments: NO_PAGED_LISTS,
  list_pull_reviews: PAGED_RESULT,
  whoami: NO_PAGED_LISTS,
  list_releases: PAGED_RESULT,
  list_labels: PAGED_RESULT,
  list_milestones: PAGED_RESULT,
  list_my_repos: PAGED_RESULT,
};

/**
 * The tools whose input schema has a filter or a paging argument, so "narrow the
 * query" is advice the caller can actually act on.
 *
 * A capped list is one thing; being able to reach the rest of it is another.
 * `list_branches`, `list_tags`, `list_releases`, `list_labels`,
 * `list_milestones`, `list_my_repos` and `list_pull_reviews` take only the
 * repository (or nothing at all), so a truncated answer from one of them cannot
 * be improved by the caller and must be reported as incomplete instead.
 */
const NARROWABLE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'list_issues',
  'get_issue',
  'list_pull_requests',
  'get_pull_request',
  'get_pr_timeline',
  'list_notifications',
  'search',
  'list_action_runs',
  'get_action_run_artifacts',
  'get_file_history',
]);

/**
 * A note for the paged lists of `pagedLists` that reached the client cap, or an
 * empty string.
 *
 * Every paged client method stops at `LIST_ITEM_LIMIT`; without this the result
 * looks complete and a caller cannot tell that more rows exist. Lists are
 * reported wherever they sit in the payload: several tools return an object
 * wrapping one (`get_issue` carries `comments`, `get_pull_request` carries
 * `files` and `commits`), and a capped list inside it would otherwise go
 * unannounced.
 *
 * `canNarrow` decides what the caller is told to do about it: a tool with no
 * filter and no paging has no way to fetch the rest, and pointing such a caller
 * at a query it cannot pass is worse than saying the answer is incomplete.
 */
export function listTruncationNote(
  value: unknown,
  pagedLists: readonly string[],
  options: { canNarrow: boolean },
): string {
  const capped = cappedListFields(value, pagedLists);
  if (capped.length === 0) {
    return '';
  }
  const names = capped.join(', ');
  return options.canNarrow
    ? `\n(list truncated at ${LIST_ITEM_LIMIT} items: ${names}; narrow the query to see the rest)`
    : `\n(list truncated at ${LIST_ITEM_LIMIT} items: ${names}; the result is incomplete and this tool has no filter or paging, so the remaining items cannot be fetched through the MCP tools — read them in the Forgejo web UI, or use a narrower tool for the same data)`;
}

/**
 * A note for `get_repo`, whose branch and commit lists are capped by
 * `getRepoDetail`'s `{ limit: REPO_DETAIL_LIST_LIMIT }`.
 *
 * The lists are not `LIST_ITEM_LIMIT`-paged, so `listTruncationNote` does not
 * see them at all. Without a note a caller reads ten branches as "this
 * repository has ten branches" and concludes that the branch it wanted does not
 * exist.
 */
export function repoDetailCapNote(value: unknown): string {
  const detail = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const capped = ['branches', 'recentCommits'].filter((field) => {
    const list = detail?.[field];
    return Array.isArray(list) && list.length >= REPO_DETAIL_LIST_LIMIT;
  });
  return capped.length === 0
    ? ''
    : `\n(note: ${capped.join(' and ')} is capped at ${REPO_DETAIL_LIST_LIMIT} items by this tool; the list is incomplete. Use list_branches for the full branch list, or the Forgejo web UI for the full commit history.)`;
}

/**
 * A note for `search_repo_files`, whose `truncated` flag has two causes: the git
 * tree could not be read completely, or the match list hit
 * `MAX_SEARCH_RESULTS`. Only the second is recoverable by narrowing the query,
 * so the note names the cause it can see and stays silent otherwise. The flag
 * itself is reported inside the result.
 */
export function repoSearchTruncationNote(value: unknown): string {
  const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  if (result?.truncated !== true) {
    return '';
  }
  const files = result.files;
  if (Array.isArray(files) && files.length >= MAX_SEARCH_RESULTS) {
    return `\n(matches capped at ${MAX_SEARCH_RESULTS}: the result is incomplete; a narrower query would return the rest)`;
  }
  return '\n(the repository tree could not be read completely, so the matches may be incomplete)';
}

/**
 * The names in `pagedLists` whose value is a list that reached the cap. Only
 * the lists a client method pages are considered (see `PAGED_LISTS`), so a
 * complete single-page list of the same length is not reported as cut off.
 */
function cappedListFields(value: unknown, pagedLists: readonly string[]): string[] {
  const isCapped = (candidate: unknown): boolean => Array.isArray(candidate) && candidate.length >= LIST_ITEM_LIMIT;
  const fields = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  return pagedLists.filter((field) => isCapped(field === RESULT_FIELD ? value : fields?.[field]));
}
/** Wraps a handler run into an MCP tool result: truncation + error rendering. */
async function callTool(tool: ToolName, run: () => Promise<unknown>) {
  try {
    const result = truncateLargeStrings(await run());
    const serialized = JSON.stringify(result, null, 2) ?? 'null';
    const text =
      (serialized.length > MAX_TOOL_RESULT_LENGTH
        ? `${serialized.slice(0, MAX_TOOL_RESULT_LENGTH)}\n... (truncated: the result exceeded ${Math.round(MAX_TOOL_RESULT_LENGTH / 1024)} KB and was cut off)`
        : serialized) +
      listTruncationNote(result, PAGED_LISTS[tool], { canNarrow: NARROWABLE_TOOLS.has(tool) }) +
      // Two tools carry a cut the paged-list classification cannot see: get_repo
      // caps its branch and commit lists at REPO_DETAIL_LIST_LIMIT, and
      // search_repo_files reports its own `truncated` flag with two causes.
      (tool === 'get_repo' ? repoDetailCapNote(result) : '') +
      (tool === 'search_repo_files' ? repoSearchTruncationNote(result) : '');
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
  // A cancelled tool call should abort its HTTP requests. The SDK passes the signal
  // in the tool callback's second argument, and `withSignal` is cheap, so the
  // handlers are rebuilt around a signalling client instead of threading a
  // parameter through all of them.
  const handlersFor = (extra?: { signal?: AbortSignal }) =>
    extra?.signal ? buildToolHandlers(client.withSignal(extra.signal)) : handlers;
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    'list_issues',
    {
      description:
        'List issues. With owner and repo, lists the issues of that repository (optionally keyword-filtered); without them, lists issues across the instance that involve the authenticated user (the same keyword filter is applied to the returned rows).',
      inputSchema: {
        owner: ownerSchema,
        repo: repoSchema,
        state: stateSchema,
        query: z.string().optional().describe('Keyword filter on title, body, or author (applied in both listings).'),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_issues', () => handlersFor(extra).list_issues(args)),
  );

  server.registerTool(
    'get_issue',
    {
      description: 'Get a single issue by number, including its comments.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: z.number().int().positive().describe('Issue number.'),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('get_issue', () => handlersFor(extra).get_issue(args)),
  );

  server.registerTool(
    'list_pull_requests',
    {
      description:
        'List pull requests. With owner and repo, lists the pull requests of that repository (optionally keyword-filtered); without them, lists pull requests across the instance that involve the authenticated user (the same keyword filter is applied to the returned rows).',
      inputSchema: {
        owner: ownerSchema,
        repo: repoSchema,
        state: stateSchema,
        query: z.string().optional().describe('Keyword filter on title, body, or author (applied in both listings).'),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_pull_requests', () => handlersFor(extra).list_pull_requests(args)),
  );

  server.registerTool(
    'get_pull_request',
    {
      description:
        'Get a single pull request by number, including changed files, commits, merge blockers, and status checks.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: z.number().int().positive().describe('Pull request number.'),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('get_pull_request', () => handlersFor(extra).get_pull_request(args)),
  );

  server.registerTool(
    'get_pr_timeline',
    {
      description: 'Get the comment and event timeline of a pull request (review comments, status changes, etc.).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: z.number().int().positive().describe('Pull request number.'),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('get_pr_timeline', () => handlersFor(extra).get_pr_timeline(args)),
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
    async (args, extra) => callTool('list_notifications', () => handlersFor(extra).list_notifications(args)),
  );

  server.registerTool(
    'get_repo',
    {
      description: `Get repository details, including README, branches, and recent commits. The branches and recentCommits lists are capped at ${REPO_DETAIL_LIST_LIMIT} items each, so a short list does not mean the repository has only that many: use list_branches for the complete branch list.`,
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('get_repo', () => handlersFor(extra).get_repo(args)),
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
    async (args, extra) => callTool('search', () => handlersFor(extra).search(args)),
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
    async (args, extra) => callTool('list_action_runs', () => handlersFor(extra).list_action_runs(args)),
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
    async (args, extra) => callTool('get_action_run_jobs', () => handlersFor(extra).get_action_run_jobs(args)),
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
    async (args, extra) => callTool('get_action_job_log', () => handlersFor(extra).get_action_job_log(args)),
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
    async (args, extra) =>
      callTool('get_action_run_artifacts', () => handlersFor(extra).get_action_run_artifacts(args)),
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
    async (args, extra) => callTool('get_file_content', () => handlersFor(extra).get_file_content(args)),
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
    async (args, extra) => callTool('list_repo_contents', () => handlersFor(extra).list_repo_contents(args)),
  );

  server.registerTool(
    'list_branches',
    {
      description: 'List the branches of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_branches', () => handlersFor(extra).list_branches(args)),
  );

  server.registerTool(
    'list_tags',
    {
      description: 'List the tags of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_tags', () => handlersFor(extra).list_tags(args)),
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
    async (args, extra) => callTool('list_commits', () => handlersFor(extra).list_commits(args)),
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
    async (args, extra) => callTool('get_file_history', () => handlersFor(extra).get_file_history(args)),
  );

  server.registerTool(
    'search_repo_files',
    {
      description: `Search file paths in a repository by keyword (case-insensitive substring match over the git tree). Returns the matching paths and \`truncated\`, which is true in two cases: the repository tree was too large to read completely (matches may be missing), or the match list hit its cap of ${MAX_SEARCH_RESULTS} and was cut short (a narrower query returns the rest).`,
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        query: z.string().describe('Keyword to match against file paths.'),
        ref: refSchema,
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('search_repo_files', () => handlersFor(extra).search_repo_files(args)),
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
    async (args, extra) => callTool('get_pr_diff', () => handlersFor(extra).get_pr_diff(args)),
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
    async (args, extra) =>
      callTool('get_pull_review_comments', () => handlersFor(extra).get_pull_review_comments(args)),
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
    async (args, extra) => callTool('list_pull_reviews', () => handlersFor(extra).list_pull_reviews(args)),
  );

  server.registerTool(
    'whoami',
    {
      description: 'Get the authenticated user the configured token belongs to.',
      inputSchema: {},
      annotations: readOnly,
    },
    async (_args, extra) => callTool('whoami', () => handlersFor(extra).whoami()),
  );

  server.registerTool(
    'list_releases',
    {
      description: 'List the releases of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_releases', () => handlersFor(extra).list_releases(args)),
  );

  server.registerTool(
    'list_labels',
    {
      description: 'List the labels of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_labels', () => handlersFor(extra).list_labels(args)),
  );

  server.registerTool(
    'list_milestones',
    {
      description: 'List the open milestones of a repository.',
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_milestones', () => handlersFor(extra).list_milestones(args)),
  );

  server.registerTool(
    'list_my_repos',
    {
      description: 'List the repositories of the authenticated user (owned and collaborated).',
      inputSchema: {},
      annotations: readOnly,
    },
    async (_args, extra) => callTool('list_my_repos', () => handlersFor(extra).list_my_repos()),
  );
}
