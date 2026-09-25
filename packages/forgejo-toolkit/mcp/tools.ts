import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  LIST_ITEM_LIMIT,
  MAX_JOB_LOG_LENGTH,
  MAX_SEARCH_RESULTS,
  REPO_DETAIL_LIST_LIMIT,
  type ForgejoClient,
} from '../src/api/client';
import { toApiError, userFacingErrorMessage } from '../src/api/errors-core';
import { resolveWorkspaceRepository } from './workspaceState';

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
  /** Page cursor: only notifications updated before this instant (RFC 3339). */
  before?: string;
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

export interface CiFailureSummaryArgs extends RepoRefArgs {
  runId: number;
  /** Also list the jobs that passed (name and status only; their logs are never read). */
  includePassedJobs?: boolean;
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
 * Workspace context the extension host passes down to the MCP child through
 * its launch environment (see src/mcpWorkspaceState.ts). Both fields are
 * optional: the server can also run without them (e.g. in unit tests), in
 * which case `get_workspace_repository` stays registered and answers
 * "not configured" instead of disappearing from the tool surface.
 */
export interface WorkspaceContextOptions {
  /** Path of this window's workspace state file (FORGEJO_MCP_STATE_FILE). */
  stateFile?: string;
  /** This process's own instance URL (FORGEJO_MCP_INSTANCE_URL), matched against state entries. */
  instanceUrl?: string;
  /**
   * This process's own instance id (FORGEJO_MCP_INSTANCE_ID). Matched before
   * the URL so two accounts on the same host stay apart; absent when the host
   * that spawned this process predates the variable, in which case the
   * resolver falls back to the URL.
   */
  instanceId?: string;
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
 * The keyword is filtered by the server on both listing branches: the
 * repository-scoped endpoint (`/repos/{owner}/{repo}/issues?q=…`) and the
 * instance-wide issue search the client falls back to both run the query
 * through Forgejo's issue indexer, which matches the issue title, its body and
 * its comments (and an issue reference such as `#123`).
 *
 * This file used to apply a second, narrower filter over the returned rows.
 * That silently dropped matches: the indexer matches comment bodies and the
 * local filter did not, so the intersection removed every issue that had
 * matched only through a comment — with no truncation note, because the note
 * only fires at the `LIST_ITEM_LIMIT` cap. The server's own matcher is the
 * truth here, and the tool descriptions say what it matches.
 */

/**
 * One failed job's evidence inside a `get_ci_failure_summary` result.
 *
 * `log` is absent when no extraction could be produced and `extractionNote`
 * then says why, so a failed job never disappears from the summary without a
 * reason attached to it.
 */
export interface CiJobFailureSummary {
  id?: number;
  name?: string;
  status?: string;
  log?: CiJobLogSummary;
  extractionNote?: string;
}

/** What was extracted from one failed job's log, and how it was cut. */
export interface CiJobLogSummary {
  /** Characters the client returned, i.e. after its own 10 MB cap. */
  logCharacters: number;
  /**
   * True when `getActionJobLog`'s own cap cut the log before this tool saw it.
   * That cap keeps the head, so `tail` then holds the end of the first 10 MB —
   * not the end of the real log — and the real log's size is unknown.
   */
  truncatedByClient: boolean;
  /** Set only when `truncatedByClient`: a plain-language marker for the agent. */
  truncationNote?: string;
  /** Total lines in the log as the client returned it. */
  logLines: number;
  /** Error-looking lines with their surrounding context, oldest shown first. */
  errorContext: string;
  /** How many lines matched the error patterns, before the display cap. */
  errorMatchCount: number;
  /** True when matched error lines had to be dropped to fit the slice. */
  errorContextTruncated: boolean;
  /** The last lines of the log; the end of the log is what is kept. */
  tail: string;
  /** Lines present in `tail`. */
  tailLines: number;
  /** True when `tail` holds fewer lines than `CI_TAIL_LINE_COUNT`. */
  tailTruncated: boolean;
}

/**
 * Whether a job's status (or a GitHub-compatible `conclusion`) reports a
 * failure. The Forgejo Actions vocabulary (`models/actions/status.go`) calls it
 * `failure`; `error` is the same outcome under an older spelling, which is also
 * what `isActionStatusFailed` in the webview treats as failed.
 */
export function isFailedActionJob(job: { status?: string; conclusion?: string }): boolean {
  return isFailureStatus(job.status) || isFailureStatus(job.conclusion);
}

function isFailureStatus(status?: string): boolean {
  return status === 'failure' || status === 'error';
}

/** Context lines kept on each side of a matched error line. */
export const CI_ERROR_CONTEXT_LINES = 2;
/** Matched error lines shown per failed job, keeping those nearest the end. */
export const CI_ERROR_MATCH_LIMIT = 20;
/** Lines kept from the end of each failed job log. */
export const CI_TAIL_LINE_COUNT = 100;
/**
 * Total characters of extracted text shared by all failed jobs.
 *
 * `callTool` caps each string field at `MAX_TOOL_TEXT_LENGTH` and the whole
 * serialized result at `MAX_TOOL_RESULT_LENGTH`, and both caps keep the start.
 * A payload that relied on them would therefore lose the log tail this tool
 * exists to deliver, so the extractor stays well inside both caps by itself.
 */
export const CI_SUMMARY_EXTRACT_BUDGET = 48 * 1024;
/**
 * Ceiling for one job, so a single noisy log cannot consume the shared budget.
 * Must stay below `MAX_TOOL_TEXT_LENGTH`: the tail takes 60% of it and the
 * error lines the rest, so neither slice can trip the per-field cap.
 */
export const CI_SUMMARY_MAX_JOB_BUDGET = 12 * 1024;
/**
 * Smallest slice worth producing. Below it the remaining failed jobs are listed
 * without extraction instead of each getting a few unreadable characters.
 */
export const CI_SUMMARY_MIN_JOB_BUDGET = 1536;
/** Share of a job's slice that goes to the log tail: the failure prints last. */
const CI_TAIL_BUDGET_SHARE = 0.6;

/**
 * What counts as an error-looking line. Broad on purpose — the agent reads the
 * lines and judges them — but the benign patterns below stop a build's progress
 * output from filling the slice with phrases like "0 errors" or "error-free".
 */
const CI_ERROR_LINE_PATTERN =
  /##\[error\]|\bpanic(?:ked)?\b|\bfatal\b|\bexception\b|\b[A-Za-z]+Error\b|\bfail(?:ed|ures?)?\b|\berrors?\b|\bexit code\s*[1-9]\d*/i;
/** Lines that contain an error word without reporting a failure. */
const CI_BENIGN_ERROR_PATTERN =
  /\b(?:no|zero|without)\s+(?:errors?|failures?)\b|\berror-?free\b|\berrors?:\s*0\b|\b0\s+errors?\b/i;
/** Markers that report a failure outright, benign wording notwithstanding. */
const CI_STRONG_ERROR_PATTERN =
  /##\[error\]|\bpanic(?:ked)?\b|\bfatal\b|\bexception\b|\b[A-Za-z]+Error\b|\bexit code\s*[1-9]\d*/i;

/**
 * Whether a line looks like it reports a failure. A line that only counts zero
 * errors (or talks about error handling) is skipped unless it also carries an
 * unambiguous marker such as `##[error]`, a panic or a non-zero exit code.
 */
export function isCiErrorLine(line: string): boolean {
  if (!CI_ERROR_LINE_PATTERN.test(line)) {
    return false;
  }
  return CI_STRONG_ERROR_PATTERN.test(line) || !CI_BENIGN_ERROR_PATTERN.test(line);
}

/**
 * Whether the log string is the head slice produced by `getActionJobLog`'s own
 * 10 MB cap rather than the whole log. The cap is injectable so a test does not
 * need a 10 MB fixture.
 */
export function logWasTruncatedByClient(log: string, cap: number = MAX_JOB_LOG_LENGTH): boolean {
  return log.length > cap;
}

/** `lineNumber: text` for one 1-based inclusive line range. */
function formatNumberedLines(lines: readonly string[], start: number, end: number): string {
  const selected: string[] = [];
  for (let index = start; index <= end; index += 1) {
    selected.push(`${index + 1}: ${lines[index]}`);
  }
  return selected.join('\n');
}

/**
 * The error-looking lines of `log`, each with `CI_ERROR_CONTEXT_LINES` lines of
 * context, merged so overlapping windows print once and numbered by their log
 * line.
 *
 * Only the last `CI_ERROR_MATCH_LIMIT` matches are kept. A CI log repeats words
 * like "error" in early progress output while the failure that ended the job
 * prints last, so keeping the earliest matches would spend the whole slice on
 * noise. When the slice is still too small for those matches, the oldest ones
 * are dropped first and `truncated` says so.
 */
export function extractCiErrorContext(
  log: string,
  maxChars: number = Math.floor(CI_SUMMARY_MAX_JOB_BUDGET * (1 - CI_TAIL_BUDGET_SHARE)),
): { text: string; matchCount: number; truncated: boolean } {
  const logLines = log.split(/\r?\n/);
  const matchIndexes: number[] = [];
  for (let index = 0; index < logLines.length; index += 1) {
    if (isCiErrorLine(logLines[index])) {
      matchIndexes.push(index);
    }
  }
  const matchCount = matchIndexes.length;
  const kept = matchIndexes.slice(-CI_ERROR_MATCH_LIMIT);
  const windows: { start: number; end: number }[] = [];
  for (const index of kept) {
    const start = Math.max(0, index - CI_ERROR_CONTEXT_LINES);
    const end = Math.min(logLines.length - 1, index + CI_ERROR_CONTEXT_LINES);
    const previous = windows[windows.length - 1];
    if (previous && start <= previous.end + 1) {
      previous.end = Math.max(previous.end, end);
    } else {
      windows.push({ start, end });
    }
  }

  // Walk the windows from the end so the match closest to the failure survives
  // a tight slice, then reorder what fit.
  let truncated = kept.length < matchCount;
  const blocks: string[] = [];
  let used = 0;
  for (let index = windows.length - 1; index >= 0; index -= 1) {
    const { start, end } = windows[index];
    const block = formatNumberedLines(logLines, start, end);
    if (blocks.length === 0) {
      if (block.length > maxChars) {
        // Even the nearest window alone is over budget: keep its start, where
        // the matched line's block begins, rather than dropping the only
        // evidence there is.
        blocks.push(block.slice(0, maxChars));
        truncated = true;
        break;
      }
    } else if (used + block.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    blocks.unshift(block);
    used += block.length + 1;
  }
  return { text: blocks.join('\n'), matchCount, truncated };
}

/**
 * The last `CI_TAIL_LINE_COUNT` lines of `log`, numbered, shortened from the
 * front until it fits `maxChars`. The end of the log is the part that survives:
 * a failing step prints its error there, which is exactly what the raw log
 * tool's head-keeping budget loses.
 */
export function extractCiLogTail(
  log: string,
  maxChars: number = Math.floor(CI_SUMMARY_MAX_JOB_BUDGET * CI_TAIL_BUDGET_SHARE),
): { text: string; lineCount: number; truncated: boolean } {
  const logLines = log.split(/\r?\n/);
  const requestedStart = Math.max(0, logLines.length - CI_TAIL_LINE_COUNT);
  let start = requestedStart;
  let truncated = requestedStart > 0;
  while (start < logLines.length - 1 && formatNumberedLines(logLines, start, logLines.length - 1).length > maxChars) {
    start += 1;
    truncated = true;
  }
  let text = formatNumberedLines(logLines, start, logLines.length - 1);
  if (text.length > maxChars) {
    // One line alone can exceed the slice (a minified stack trace); keep its
    // end, where the failure usually is.
    text = text.slice(text.length - maxChars);
    truncated = true;
  }
  return { text, lineCount: logLines.length - start, truncated };
}

/** Extracts a failed job's evidence from its log within `budget` characters. */
export function summarizeCiJobLog(
  log: string,
  budget: number = CI_SUMMARY_MAX_JOB_BUDGET,
  clientCap: number = MAX_JOB_LOG_LENGTH,
): CiJobLogSummary {
  const tailBudget = Math.floor(budget * CI_TAIL_BUDGET_SHARE);
  const error = extractCiErrorContext(log, budget - tailBudget);
  const tail = extractCiLogTail(log, tailBudget);
  const truncatedByClient = logWasTruncatedByClient(log, clientCap);
  return {
    logCharacters: log.length,
    truncatedByClient,
    // The client cap is the one cut that can hide the failure entirely, because
    // it removes the tail instead of the head; the flags alone are easy to miss.
    truncationNote: truncatedByClient
      ? 'the client cut this log at its own job-log cap, keeping the start: the tail above is not the end of the real log, its real size is unknown, and only the Forgejo web UI can show the rest'
      : undefined,
    logLines: log.split(/\r?\n/).length,
    errorContext: error.text,
    errorMatchCount: error.matchCount,
    errorContextTruncated: error.truncated,
    tail: tail.text,
    tailLines: tail.lineCount,
    tailTruncated: tail.truncated,
  };
}

/**
 * Plain async handlers behind the MCP tools, exported for unit tests: they
 * return the untruncated payload and let errors propagate. The MCP
 * registration (registerTools) adds truncation and error rendering on top.
 */
export function buildToolHandlers(client: ForgejoClient, workspaceContext: WorkspaceContextOptions = {}) {
  return {
    // Reads the state file fresh on every call: the workspace changes while
    // this long-lived process runs, and a cached answer would quietly go
    // stale. Needs no HTTP, so the client's abort signal does not apply.
    get_workspace_repository: () =>
      resolveWorkspaceRepository(workspaceContext.stateFile, workspaceContext.instanceUrl, workspaceContext.instanceId),

    // The scope assertion stays in a synchronous arrow so a half-specified
    // scope throws (rather than rejecting) before any request is issued. The
    // keyword goes to the server on both branches (see the note above), so no
    // row the server matched is discarded afterwards.
    list_issues: (args: ListIssuesArgs) => {
      assertCompleteRepoScope(args.owner, args.repo);
      return args.owner && args.repo
        ? client.getRepoIssues(args.owner, args.repo, args.state ?? 'open', args.query)
        : client.getUserIssues(args.state ?? 'open', args.query);
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
      return args.owner && args.repo
        ? client.getRepoPullRequests(args.owner, args.repo, args.state ?? 'open', args.query)
        : client.getUserPullRequests(args.state ?? 'open', args.query);
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

    // One page of up to `limit` rows. `before` is the API's own page cursor
    // (only threads updated before that instant; see `getNotifications`), so a
    // caller can fetch the next page with the `updated_at` of the oldest row it
    // received. The client does not page to `LIST_ITEM_LIMIT` here — the page
    // size is the caller's own choice — so `PAGED_LISTS` stays silent for this
    // tool (as it does for `list_action_runs`, whose page is also caller-sized)
    // and the description, not a note, tells the caller what a full page means.
    list_notifications: (args: ListNotificationsArgs) =>
      client.getNotifications(args.statusTypes ?? ['unread', 'pinned'], undefined, args.limit ?? 50, args.before),

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

    // One call replaces list_action_runs + get_action_run_jobs + one
    // get_action_job_log per failed job, and — unlike the raw log tool, whose
    // result budget keeps the *head* — it returns the end of each failed job's
    // log together with the error-looking lines. Everything it extracts is
    // pre-sized to the shared result budget (see the constants above), so
    // callTool's own truncation never has to cut the tail it worked to obtain.
    get_ci_failure_summary: async (args: CiFailureSummaryArgs) => {
      const jobs = await client.getActionRunJobs(args.owner, args.repo, args.runId);
      const failedJobs = jobs.filter(isFailedActionJob);
      const passedJobs = jobs.filter((job) => !isFailedActionJob(job));
      const failures: CiJobFailureSummary[] = [];
      let remainingBudget = CI_SUMMARY_EXTRACT_BUDGET;
      let budgetExhausted = false;

      for (const [index, job] of failedJobs.entries()) {
        const summary: CiJobFailureSummary = { id: job.id, name: job.name, status: job.status };
        if (job.id === undefined) {
          summary.extractionNote = 'the job carries no id, so its log cannot be read';
          failures.push(summary);
          continue;
        }
        // Split what is left evenly over the failed jobs not yet handled, capped
        // so one job cannot take the whole budget.
        const share = Math.min(CI_SUMMARY_MAX_JOB_BUDGET, Math.floor(remainingBudget / (failedJobs.length - index)));
        if (budgetExhausted || share < CI_SUMMARY_MIN_JOB_BUDGET) {
          // Once a useful slice is impossible it stays impossible for the rest,
          // so the flag keeps this deterministic instead of letting a later job
          // grab a larger share.
          budgetExhausted = true;
          summary.extractionNote = `log extraction skipped: the shared ${Math.round(CI_SUMMARY_EXTRACT_BUDGET / 1024)} KB budget cannot give this and the remaining failed jobs a useful slice; read this job's log with get_action_job_log instead`;
          failures.push(summary);
          continue;
        }
        remainingBudget -= share;
        try {
          const log = await client.getActionJobLog(args.owner, args.repo, job.id);
          summary.log = summarizeCiJobLog(log, share);
        } catch (error) {
          // A cancelled call is not a per-job failure: absorbing it would let a
          // cancelled tool call come back as a successful partial summary. A
          // timeout stays a per-job problem (the other jobs are still useful).
          if (toApiError(error).kind === 'cancelled') {
            throw error;
          }
          // One unreadable log (a job that never uploaded one, a transient
          // failure) must not discard the other jobs' evidence; the reason is
          // carried with the job instead. userFacingErrorMessage never includes
          // request headers, so the token cannot leak here.
          summary.extractionNote = `log unavailable: ${userFacingErrorMessage(error)}`;
        }
        failures.push(summary);
      }

      return {
        runId: args.runId,
        jobCount: jobs.length,
        failedJobCount: failedJobs.length,
        // Every job that did not report a failure. `passedJobs` carries the real
        // status, so a skipped or cancelled job is not read as a success.
        passedJobCount: passedJobs.length,
        failures,
        // Only when asked: a passed job's log is rarely worth the budget, and
        // the count above already says how many were left out.
        passedJobs:
          args.includePassedJobs === true
            ? passedJobs.map((job) => ({ id: job.id, name: job.name, status: job.status }))
            : undefined,
      };
    },

    get_action_run_artifacts: (args: ActionRunRefArgs) =>
      client.getActionRunArtifacts(args.owner, args.repo, args.runId),

    // Code reading.
    get_file_content: async (args: FileContentArgs) => {
      const read = await client.getFileContentResult(args.owner, args.repo, args.path, args.ref);
      // The contents endpoint answers a directory with its listing, a symlink
      // with its target and a submodule with its git URL — none of them file
      // content. The client reports which kind it found, so the answer does not
      // have to be recognised by parsing prose: every non-file kind is thrown
      // here and `callTool` renders it as `isError: true` with the client's own
      // sentence. The genuinely withheld >10 MiB payload stays a successful
      // result on purpose: it is an accepted instance limitation that names what
      // to do instead (see KNOWN_ISSUES.md), not a mistake in the request.
      if (read.kind !== 'file' && read.kind !== 'withheld') {
        throw new Error(read.text);
      }
      return read.text;
    },

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
      // The client already marks which cause cut the answer short; the result is
      // passed through unchanged so the note can name it (see
      // repoSearchTruncationNote).
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
 * for 10, `search_repo_files` applies its own cap and reports `truncated`, and
 * `list_notifications` returns one caller-sized page (it is paged with its own
 * `before` cursor, not to the shared cap) — and a complete one of those that
 * happens to hold `LIST_ITEM_LIMIT` rows must not be announced as truncated.
 * Every tool is listed explicitly so a new one is a compile error until its
 * lists have been classified.
 */
const PAGED_LISTS: Record<ToolName, readonly string[]> = {
  get_workspace_repository: NO_PAGED_LISTS,
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
  get_ci_failure_summary: NO_PAGED_LISTS,
  get_action_run_artifacts: PAGED_RESULT,
  get_file_content: NO_PAGED_LISTS,
  list_repo_contents: NO_PAGED_LISTS,
  list_branches: PAGED_RESULT,
  list_tags: PAGED_RESULT,
  list_commits: NO_PAGED_LISTS,
  get_file_history: PAGED_RESULT,
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
 *
 * The same goes for the tools that take one revision or one record — `get_issue`,
 * `get_pull_request`, `get_pr_timeline`, `get_action_run_artifacts` (owner, repo
 * and a number) and `get_file_history` (whose `ref` selects a revision, not a
 * narrower slice of the history, and which pages up to the shared 500-commit
 * cap): none of them has a filter or a page to pass, so listing them here
 * would have the note tell the caller to narrow a query it cannot send.
 * `get_file_history` is in `PAGED_LISTS`, so reaching that cap is still
 * announced — as an incomplete answer, not as something to narrow.
 */
const NARROWABLE_TOOLS: ReadonlySet<ToolName> = new Set<ToolName>([
  'list_issues',
  'list_pull_requests',
  'list_notifications',
  'search',
  'list_action_runs',
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
 * A note for `get_repo`, whose branch and commit lists are capped at
 * `REPO_DETAIL_LIST_LIMIT`.
 *
 * The lists are not `LIST_ITEM_LIMIT`-paged, so `listTruncationNote` does not
 * see them at all. Without a note a caller reads ten branches as "this
 * repository has ten branches" and concludes that the branch it wanted does not
 * exist.
 *
 * Whether a list was actually cut is `getRepoDetail`'s own report, not a length
 * comparison: the client asks for one row beyond the cap and keeps that extra
 * row out of the result, so a repository with exactly
 * `REPO_DETAIL_LIST_LIMIT` branches is complete. Comparing lengths instead
 * called that complete list truncated and told its caller the list was
 * incomplete — the same mistake the file-search cap avoids by reporting the cut
 * it observed (see `searchRepoFiles`).
 */
export function repoDetailCapNote(value: unknown): string {
  const detail = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const capped = (
    [
      ['branches', 'branchesTruncated'],
      ['recentCommits', 'recentCommitsTruncated'],
    ] as const
  )
    .filter(([, truncatedFlag]) => detail?.[truncatedFlag] === true)
    .map(([field]) => field);
  return capped.length === 0
    ? ''
    : `\n(note: ${capped.join(' and ')} is capped at ${REPO_DETAIL_LIST_LIMIT} items by this tool; the list is incomplete. Use list_branches for the full branch list, or the Forgejo web UI for the full commit history.)`;
}

/**
 * A note for `search_repo_files`, whose `truncated` flag has two causes: the git
 * tree could not be read completely, or the match list hit `MAX_SEARCH_RESULTS`.
 * Only the second is recoverable by narrowing the query, so the note names the
 * cause it can see and stays silent otherwise. The flag itself is reported
 * inside the result.
 *
 * The cause cannot be read off the array length: the client slices `files` to
 * `MAX_SEARCH_RESULTS` before returning, so a capped list holds exactly that
 * many rows and "at or over the cap" says nothing about why it is that long. The
 * client reports which cause applied in `truncatedBy` instead, and this note
 * follows that report, falling back to the tree wording when the signal is
 * absent (a hand-built payload): an unreadable tree is the safer cause to name,
 * since "a narrower query would return the rest" is a promise only the cap can
 * keep.
 */
export function repoSearchTruncationNote(value: unknown): string {
  const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  if (result?.truncated !== true) {
    return '';
  }
  return result.truncatedBy === 'matches'
    ? `\n(matches capped at ${MAX_SEARCH_RESULTS}: the result is incomplete; a narrower query would return the rest)`
    : '\n(the repository tree could not be read completely, so the matches may be incomplete)';
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
export function registerTools(
  server: McpServer,
  client: ForgejoClient,
  workspaceContext: WorkspaceContextOptions = {},
): void {
  const handlers = buildToolHandlers(client, workspaceContext);
  // A cancelled tool call should abort its HTTP requests. The SDK passes the signal
  // in the tool callback's second argument, and `withSignal` is cheap, so the
  // handlers are rebuilt around a signalling client instead of threading a
  // parameter through all of them.
  const handlersFor = (extra?: { signal?: AbortSignal }) =>
    extra?.signal ? buildToolHandlers(client.withSignal(extra.signal), workspaceContext) : handlers;
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

  server.registerTool(
    'get_workspace_repository',
    {
      description:
        'Resolve the Forgejo repository the user is working in, from the workspace the editor has open. Call this first whenever the user refers to "this repository", "the current project", or similar without naming owner and repo, then pass the returned owner/repo to the other tools. When several repositories match, the one whose `active` flag is true is the repository the user is most likely looking at — the flag is best-effort and only set when the attribution is unambiguous, so it may be false on every entry. When the workspace repositories belong to a different configured Forgejo instance, the answer names that instance — use its MCP server instead of this one. When no workspace information is available, ask the user for owner and repo.',
      inputSchema: {},
      annotations: readOnly,
    },
    async (_args, extra) => callTool('get_workspace_repository', () => handlersFor(extra).get_workspace_repository()),
  );

  server.registerTool(
    'list_issues',
    {
      description:
        'List issues. With owner and repo, lists the issues of that repository, optionally keyword-filtered; without them, lists issues across the instance that involve the authenticated user, with the same keyword filter. The filter is applied by the server, which matches the keyword against the issue title, its body and its comments (and an issue reference such as #123); it does not match the author.',
      inputSchema: {
        owner: ownerSchema,
        repo: repoSchema,
        state: stateSchema,
        query: z
          .string()
          .optional()
          .describe(
            'Keyword filter, applied by the server on both listings: it matches the issue title, body and comments (and an issue reference such as #123), not the author.',
          ),
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
        'List pull requests. With owner and repo, lists the pull requests of that repository, optionally keyword-filtered; without them, lists pull requests across the instance that involve the authenticated user, with the same keyword filter. The filter is applied by the server, which matches the keyword against the pull request title, its body and its comments (and an issue reference such as #123); it does not match the author.',
      inputSchema: {
        owner: ownerSchema,
        repo: repoSchema,
        state: stateSchema,
        query: z
          .string()
          .optional()
          .describe(
            'Keyword filter, applied by the server on both listings: it matches the pull request title, body and comments (and an issue reference such as #123), not the author.',
          ),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_pull_requests', () => handlersFor(extra).list_pull_requests(args)),
  );

  server.registerTool(
    'get_pull_request',
    {
      description:
        'Get a single pull request by number, including changed files, commits, merge blockers, and status checks. Attachments are read from the issues API, which is the only endpoint that exposes them, so the result also carries `assets` (the attachment metadata the issues API returned, possibly undefined) and `attachmentsUnavailable: true` when that extra read failed — in which case `assets` is unknown rather than empty.',
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
      description: `List one page of Forgejo notifications for the authenticated user. A page holds at most \`limit\` notifications (default 50, max 100); a page that fills the limit is not necessarily the whole list. To fetch the next page, call the tool again with \`before\` set to the \`updated_at\` of the oldest notification in the previous page; the server keeps rows updated at exactly that instant (\`updated_unix <= before\`), so that boundary notification comes back in the next page as well and the caller must skip the row it already has.`,
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
        before: z
          .string()
          .optional()
          .describe(
            'Paging cursor: only notifications updated before this instant (RFC 3339). Set it to the `updated_at` of the oldest notification in the previous page to fetch the next page; that boundary notification is returned again (the server compares `updated_unix <= before`), so skip it.',
          ),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_notifications', () => handlersFor(extra).list_notifications(args)),
  );

  server.registerTool(
    'get_repo',
    {
      description: `Get repository details, including README, branches, and recent commits. The branches and recentCommits lists hold at most ${REPO_DETAIL_LIST_LIMIT} items each, and \`branchesTruncated\`/\`recentCommitsTruncated\` report whether the list was actually cut: a list that is shorter than the cap, or exactly at it with its flag unset, is complete. Use list_branches for the complete branch list.`,
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
      description:
        'Search issues, pull requests, or repositories across the instance. The state filter applies to type "issues" and "pull_requests" only: repositories have no state, so it is ignored for type "repositories".',
      inputSchema: {
        query: z.string().describe('Search keywords.'),
        type: z.enum(['issues', 'pull_requests', 'repositories']).describe('What to search.'),
        state: stateSchema.describe(
          'State filter (default: open). Applies to type "issues" and "pull_requests" only: repositories have no state, so the value is ignored for type "repositories".',
        ),
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
    'get_ci_failure_summary',
    {
      description: `Summarize why an Actions workflow run failed, in one call instead of list_action_runs + get_action_run_jobs + one get_action_job_log per failed job. For every failed job it returns the error-looking lines with ${CI_ERROR_CONTEXT_LINES} lines of context around each, plus the last ${CI_TAIL_LINE_COUNT} lines of that job's log — the end is where a failing step prints its error, and it is exactly what get_action_job_log loses, since that tool's ~10 KB budget keeps the start of one raw log. The result also says how much of each log was seen (logCharacters, logLines, errorMatchCount) and flags every cut: tailTruncated/errorContextTruncated, and truncatedByClient when the log exceeded the client's own 10 MB cap, in which case not even this tool could see the real tail and the full log has to be read in the Forgejo web UI. One shared extraction budget covers all failed jobs, so a job may report that extraction was skipped; read such a job with get_action_job_log. Use get_action_job_log only when you need the raw log around a line this summary flagged. Set includePassedJobs to also list the jobs that passed (name and status only).`,
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        runId: z.number().int().positive().describe('Workflow run ID (from list_action_runs).'),
        includePassedJobs: z
          .boolean()
          .optional()
          .describe('Also list the jobs that passed (name and status only, no logs). Default: false.'),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('get_ci_failure_summary', () => handlersFor(extra).get_ci_failure_summary(args)),
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
        'Get the decoded text content of a file in a repository. Large files are truncated to ~10 KB by the tool result budget. A path that names a directory (use list_repo_contents to list its entries), a symlink, or a submodule is not a file and is reported as an error naming what the entry actually is (a symlink with its link target, a submodule with its git URL, either way pointing at the web UI) instead of returning content; a file whose payload the instance withholds (above its contents API payload limit) is answered with a successful notice naming its size instead of its content.',
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
      description:
        'List the entries at a path in a repository (default: repository root): files, directories, symlinks and submodules. A directory path answers with its children; a file path answers that one entry (whose `content`, when the API sends it, is base64 — use get_file_content for decoded text).',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        path: repoPathSchema('Path within the repository (default: root).', { allowEmpty: true }).optional(),
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
      description: `List the commits that touched a file, paged up to the shared list cap of ${LIST_ITEM_LIMIT} commits. A result that reaches ${LIST_ITEM_LIMIT} commits is reported as incomplete: \`ref\` selects the revision to walk from, not a narrower slice of the history, so this tool has no filter or page to fetch the rest.`,
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
