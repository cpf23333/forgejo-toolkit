import { createHash } from 'crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PullReview, PullReviewComment } from '@cpf23333-forgejo-toolkit/api';
import {
  LIST_ITEM_LIMIT,
  MAX_JOB_LOG_LENGTH,
  MAX_SEARCH_RESULTS,
  REPO_DETAIL_LIST_LIMIT,
  type ForgejoClient,
  type PagedList,
} from '../src/api/client';
import { isListTruncatedWithTotal } from '@cpf23333-forgejo-toolkit/shared/limits';
import { toApiError, userFacingErrorMessage } from '../src/api/errors-core';
import type {
  ForgejoChangedFile,
  ForgejoIssue,
  ForgejoNotification,
  ForgejoPullRequest,
  ForgejoRepository,
  MergeBlocker,
} from '../src/api/types';
import { resolveWorkspaceRepository } from './workspaceState';
import {
  decideWriteCall,
  MCP_WRITE_BODY_MAX_BYTES,
  writeAuditRecord,
  writeIdempotencyReuseMessage,
  WRITE_IDEMPOTENCY_REPLAY_MESSAGE,
  WRITE_IDEMPOTENCY_REUSE_REASON,
  writeInstanceLabel,
  writeRefusalMessage,
  writeRefusalReason,
  WRITE_TOOL_ANNOTATIONS,
  type McpWriteAuditDraft,
  type McpWriteAuditSink,
  type McpWriteTool,
} from './writeTools';

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

export interface PrReviewBriefArgs extends IssueRefArgs {
  /** Include the per-file diff table (default: true). */
  includeDiffStats?: boolean;
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

/** Input of `create_issue_comment` (stage 1's write tool). */
export interface CreateIssueCommentArgs extends IssueRefArgs {
  /** The comment text (Markdown). Non-empty, at most `MCP_WRITE_BODY_MAX_BYTES`. */
  body: string;
  /**
   * Retry key. Reuse it for the *same* logical operation (a retry after a
   * timeout or a truncated turn) and never for a different comment; within the
   * session's 10-minute window the same key with the same target and body
   * replays the earlier result instead of writing twice.
   */
  idempotencyKey?: string;
  /** Report what would be sent, without sending it. Default: false. */
  dryRun?: boolean;
}

/**
 * The verdicts `submit_pull_review` accepts, spelled exactly as Forgejo's own
 * `ReviewStateType` spells them — this is what the server's `switch` compares
 * against, and the review stays pending on anything it does not recognise
 * (`services/pull/review.go`, `preparePullReviewType`). `APPROVE` is **not**
 * one of the three: the client library's default parameter literal is not a
 * wire value, and sending it would leave the review pending with a 422.
 *
 * `PENDING` is deliberately absent: this tool submits a review, and the server
 * refuses "review stay pending" — starting a pending review is a different
 * operation with no place in a submit tool.
 */
export const PULL_REVIEW_EVENTS = ['COMMENT', 'APPROVED', 'REQUEST_CHANGES'] as const;

/** One accepted `submit_pull_review` verdict. */
export type PullReviewEvent = (typeof PULL_REVIEW_EVENTS)[number];

/** Input of `submit_pull_review` (stage 2's write tool). */
export interface SubmitPullReviewArgs extends IssueRefArgs {
  /**
   * The id of the **pending** review to submit. Only a pending review can be
   * submitted (`POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}`);
   * an already-submitted review is refused by the server with 422.
   */
  reviewId: number;
  /** The verdict: `COMMENT`, `APPROVED` or `REQUEST_CHANGES`. */
  event: PullReviewEvent;
  /**
   * The review's message (Markdown). Required for `APPROVED` and
   * `REQUEST_CHANGES` (the server rejects those with an empty body); optional
   * for `COMMENT`, which may instead carry the pending review's inline
   * comments. At most `MCP_WRITE_BODY_MAX_BYTES`.
   */
  body?: string;
  /** Retry key — same semantics as `create_issue_comment`'s. */
  idempotencyKey?: string;
  /** Report what would be sent, without sending it. Default: false. */
  dryRun?: boolean;
}

/**
 * Input of `cancel_action_run` (the first tool of the second batch, §4.1).
 *
 * Deliberately body-less: the endpoint takes only the path (owner, repo, run
 * id), so this tool is the one write call whose audit line carries neither
 * `bytes` nor `sha256` — absent, not zero (§8's rule for a call with no body).
 */
export interface CancelActionRunArgs extends RepoRefArgs {
  /**
   * The workflow run to cancel, as `list_action_runs` reports it (Forgejo's
   * `index_in_repo` for the run, which is what the run pages and the cancel
   * button in the web UI use).
   */
  runId: number;
  /** Retry key — same semantics as `create_issue_comment`'s. */
  idempotencyKey?: string;
  /** Report what would be sent, without sending it. Default: false. */
  dryRun?: boolean;
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
  /**
   * The write tools (and therefore the provenance marker) this session carries.
   * Populated by the extension host — from its own settings for a broker
   * session, or from the launch's `FORGEJO_MCP_WRITE_TOOLS` for the child — and
   * **empty** on every other route: the zero-configuration launch, an anonymous
   * direct server, and a user's hand-written `mcp.json`. Empty means "this
   * session may not write", never "no switch is on" (see mcp/writeTools.ts).
   */
  writeTools?: readonly McpWriteTool[];
  /**
   * The subset of `writeTools` whose per-tool switch is on. The host reads its
   * own settings for this; a child cannot read settings at all, so it is only
   * ever set where the two lists are computed together (the broker).
   */
  enabledWriteTools?: readonly McpWriteTool[];
  /**
   * Who to name in the audit line, e.g. `extension host` or
   * `broker session for instance-1 (cwd D:\work\demo)` (the host prefixes
   * `extension host` itself). Defaults to the extension host, which is where
   * the tool logic actually runs.
   */
  writeCaller?: string;
  /**
   * How to name the instance in the audit line — `name (id)`, per §8 — when the
   * host knows the configured instance. Defaults to `instanceId`, or `unknown`
   * when the session has no instance at all. This is a display label only: it
   * never reaches the workspace-state resolver, which keeps using `instanceId`.
   */
  writeInstanceLabel?: string;
  /**
   * Where write-tool audit records go. Supplied by the extension host
   * (`src/mcpWriteAudit.ts`, Output Channel + optional JSONL file); absent in
   * the headless child, which never writes anyway.
   */
  writeAudit?: McpWriteAuditSink;
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
 * One changed file as `get_pr_review_brief` reports it: a row of the per-file
 * diff table. Only the line counts are carried, never the diff text — the text
 * is `get_pr_diff`'s job, and a full diff would dwarf everything else the brief
 * exists to deliver.
 */
export interface PrReviewBriefFile {
  path?: string;
  previousPath?: string;
  status?: string;
  additions?: number;
  deletions?: number;
  changes?: number;
}

/** The pull request header of a `get_pr_review_brief` result. */
export interface PrReviewBriefPullRequest {
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  author?: string;
  baseBranch?: string;
  headBranch?: string;
  /**
   * The pull request record's own flag. False also covers "the server has not
   * computed it yet" and "the required checks are still unresolved", so
   * `mergeBlockers` — not this flag on its own — is what says whether merging is
   * blocked.
   */
  mergeable?: boolean;
  /** Why the pull request cannot merge yet; empty when nothing blocks it. */
  mergeBlockers?: MergeBlocker[];
  /** True when the base branch's protection rules could not be read, so `mergeBlockers` may be incomplete. */
  protectionUnknown?: boolean;
}

/** One reviewer's latest conclusion inside a `get_pr_review_brief` result. */
export interface PrReviewBriefReviewer {
  reviewer?: string;
  state?: string;
  /** When the review was submitted; for a still-pending review, when it was last updated. */
  reviewedAt?: string;
  reviewId?: number;
  /** True when a later commit made the review outdated; it no longer counts in `summary`. */
  stale?: boolean;
  /** True when the review was dismissed; it no longer counts in `summary`. */
  dismissed?: boolean;
}

/**
 * The aggregate conclusion of the latest (current) review per reviewer.
 *
 * `approved` only means "nobody currently objects and at least one reviewer
 * approved": the required number of approvals is a branch-protection setting,
 * and `pullRequest.mergeBlockers` is where that requirement is reported.
 */
export type PrReviewBriefSummary = 'approved' | 'changes_requested' | 'awaiting_review' | 'no_reviews';

/** The review picture of a `get_pr_review_brief` result. */
export interface PrReviewBriefReviewStatus {
  /** One entry per reviewer, their most recent review, ordered by that review's position in the review list. */
  reviewers: PrReviewBriefReviewer[];
  summary: PrReviewBriefSummary;
  approvals: number;
  changesRequested: number;
  /** Reviewers whose current review neither approved nor requested changes (COMMENT, PENDING, …). */
  awaiting: number;
  /**
   * True when the review list is not the whole list: fewer rows arrived than the
   * server's own count (`totalCount`, absent when the server reported none), or
   * — with no count — the read reached the shared list cap, so older reviews may
   * be missing.
   */
  truncated: boolean;
}

/** One unresolved inline review comment inside a `get_pr_review_brief` result. */
export interface PrReviewBriefComment {
  id?: number;
  reviewId?: number;
  path?: string;
  /** 1-based line the comment is anchored to; on `side` of the diff. */
  line?: number;
  /** `new` when the line is in the head revision, `old` when it is in the base one. */
  side?: 'new' | 'old';
  author?: string;
  createdAt?: string;
  body?: string;
  /** True when the body was cut to `PR_REVIEW_MAX_COMMENT_LENGTH`. */
  bodyTruncated?: boolean;
}

/** The diff statistics of a `get_pr_review_brief` result. */
export interface PrReviewBriefDiffStats {
  /**
   * Files the pull request changes, from the pull request record. Complete even
   * when the table below is cut, so it is the number to trust for "how big is
   * this change".
   */
  fileCount?: number;
  /** Total added lines, from the pull request record. */
  additions?: number;
  /** Total deleted lines, from the pull request record. */
  deletions?: number;
  /** One row per changed file; absent when `includeDiffStats` was false. */
  files?: PrReviewBriefFile[];
  /** Rows present in `files`. */
  listedFileCount?: number;
  /** True when `files` is not the whole changed-file list. */
  truncated?: boolean;
  /**
   * Which limit cut the table: this tool's row/character budget, the client's
   * shared list cap, or 'server-partial' — the server itself returned fewer
   * files than the pull request record's `fileCount` with no cut on this side
   * (seen from Forgejo 16 when the head branch is gone after a merge).
   */
  truncatedBy?: 'list-cap' | 'row-limit' | 'budget' | 'server-partial';
}

/** The `get_pr_review_brief` result: everything needed to start a review, pre-sized to a shared budget. */
export interface PrReviewBrief {
  pullRequest: PrReviewBriefPullRequest;
  diffStats: PrReviewBriefDiffStats;
  reviewStatus: PrReviewBriefReviewStatus;
  unresolvedComments: {
    /** Unresolved comments with a body that were found, before any cap. */
    total: number;
    /** Comments present in `comments`. */
    returned: number;
    comments: PrReviewBriefComment[];
    /** True when `comments` is not the whole unresolved set. */
    truncated: boolean;
    /** Which cap stopped the list: the comment count, or the shared character budget. */
    truncatedBy?: 'count' | 'budget';
    /** Reviews whose comment list could not be read; their unresolved comments are missing. */
    unreadableReviewCount: number;
  };
}

/**
 * Shared character budget for `get_pr_review_brief`'s two pull-request-sized
 * sections, the per-file diff table and the unresolved comment bodies.
 *
 * `callTool` caps each string field at `MAX_TOOL_TEXT_LENGTH` and the whole
 * serialized result at `MAX_TOOL_RESULT_LENGTH`, and both caps keep the start: a
 * payload that relied on them would silently lose the comments at the end. The
 * sections are therefore pre-sized to stay inside both caps by construction,
 * the same way `get_ci_failure_summary` pre-sizes its log slices.
 */
export const PR_REVIEW_BRIEF_BUDGET = 48 * 1024;
/** Share of `PR_REVIEW_BRIEF_BUDGET` for the per-file diff table. */
export const PR_REVIEW_DIFF_BUDGET = 16 * 1024;
/** Share of `PR_REVIEW_BRIEF_BUDGET` for unresolved comment bodies and their metadata. */
export const PR_REVIEW_COMMENT_BUDGET = 24 * 1024;
/** Most file rows the diff table carries, so tiny rows cannot fill it with noise. */
export const PR_REVIEW_MAX_DIFF_FILES = 100;
/** Most unresolved comments the brief carries. */
export const PR_REVIEW_MAX_COMMENTS = 50;
/** Characters kept from one review comment body; the rest is announced in the body itself. */
export const PR_REVIEW_MAX_COMMENT_LENGTH = 1024;
/**
 * In-flight review-comment requests. There is no endpoint that returns a pull
 * request's inline review comments in one page — they hang off one review each —
 * so this is one request per review, and the review list can reach the shared
 * list cap. The pool size matches the client's per-comment attachment fan-out
 * and the extension's review-comment controller, which read the same endpoint.
 */
const PR_REVIEW_COMMENT_FETCH_CONCURRENCY = 4;

/**
 * The state spellings a change request arrives under. Forgejo's own
 * `ReviewStateType` says `REQUEST_CHANGES`; the MCP descriptions and the
 * extension's review editor use GitHub's `CHANGES_REQUESTED` spelling, and the
 * value is passed through verbatim, so both are recognised here.
 */
function isChangesRequestedState(state?: string): boolean {
  return state === 'REQUEST_CHANGES' || state === 'CHANGES_REQUESTED';
}

/**
 * The line and diff side a review comment is anchored to. Forgejo reports
 * `position` as the line in the new file and `original_position` as the line in
 * the old one; the unused side is 0. A comment that carries neither (an
 * outdated comment whose file no longer exists) has no line.
 */
function reviewCommentLocation(comment: PullReviewComment): { line?: number; side?: 'new' | 'old' } {
  if (typeof comment.position === 'number' && comment.position > 0) {
    return { line: comment.position, side: 'new' };
  }
  if (typeof comment.original_position === 'number' && comment.original_position > 0) {
    return { line: comment.original_position, side: 'old' };
  }
  return {};
}

/**
 * The key a review comment's conversation is grouped under.
 *
 * Forgejo resolves a whole conversation, and upstream sets the `resolver` field
 * only on the first comment of that conversation — every reply keeps it empty
 * (see gitea's `ToPullReviewCommentList`). Judging each comment by its own
 * `resolver` would therefore report every reply inside a resolved conversation
 * as unresolved, so comments are grouped by the location the server itself keys
 * its comment buckets on: file path plus line. Two independent conversations on
 * the same path and line share a group; the server groups them the same way, so
 * a reply cannot be separated from its conversation here either.
 */
function reviewCommentConversationKey(comment: PullReviewComment): string {
  const location = reviewCommentLocation(comment);
  return JSON.stringify([comment.path ?? '', location.side ?? '', location.line ?? 0]);
}

/** Maps a raw review comment to the brief's shape, truncating an oversized body. */
function toPrReviewBriefComment(comment: PullReviewComment): PrReviewBriefComment {
  const body = comment.body ?? '';
  const overflow = body.length - PR_REVIEW_MAX_COMMENT_LENGTH;
  const location = reviewCommentLocation(comment);
  return {
    id: comment.id,
    reviewId: comment.pull_request_review_id,
    path: comment.path,
    line: location.line,
    side: location.side,
    author: comment.user?.login,
    createdAt: comment.created_at,
    body:
      overflow > 0
        ? `${body.slice(0, PR_REVIEW_MAX_COMMENT_LENGTH)}\n... (truncated: ${overflow} more characters)`
        : body,
    bodyTruncated: overflow > 0 ? true : undefined,
  };
}

/**
 * The unresolved review comments of a pull request, newest kept first, cut to
 * `PR_REVIEW_MAX_COMMENTS` and `budget` characters.
 *
 * A conversation counts as resolved when any of its comments carries a
 * `resolver` (see `reviewCommentConversationKey`); only comments with a body are
 * listed, because a bodyless anchor carries no feedback to act on. When the caps
 * bite, the newest comments survive: a truncated brief is most useful when it
 * describes what the pull request is currently about, and the oldest remarks are
 * the ones most likely to have been answered already.
 */
export function summarizeUnresolvedComments(
  comments: readonly PullReviewComment[],
  budget: number = PR_REVIEW_COMMENT_BUDGET,
): Pick<PrReviewBrief['unresolvedComments'], 'total' | 'returned' | 'comments' | 'truncated' | 'truncatedBy'> {
  const resolvedConversations = new Set<string>();
  for (const comment of comments) {
    if (comment.resolver) {
      resolvedConversations.add(reviewCommentConversationKey(comment));
    }
  }
  const unresolved = comments
    .filter(
      (comment) => (comment.body ?? '').length > 0 && !resolvedConversations.has(reviewCommentConversationKey(comment)),
    )
    .map(toPrReviewBriefComment);

  const kept: PrReviewBriefComment[] = [];
  let used = 0;
  let truncatedBy: 'count' | 'budget' | undefined;
  for (let index = unresolved.length - 1; index >= 0; index -= 1) {
    if (kept.length >= PR_REVIEW_MAX_COMMENTS) {
      truncatedBy = 'count';
      break;
    }
    const comment = unresolved[index];
    const cost = JSON.stringify(comment).length + 1;
    if (used + cost > budget) {
      truncatedBy = 'budget';
      break;
    }
    used += cost;
    kept.push(comment);
  }
  return {
    total: unresolved.length,
    returned: kept.length,
    comments: kept.reverse(),
    truncated: unresolved.length > kept.length,
    // The marker only makes sense when something was actually left out; a
    // complete list must not carry the limit that would have applied.
    truncatedBy: unresolved.length > kept.length ? truncatedBy : undefined,
  };
}

/**
 * The diff table of a `get_pr_review_brief` result. `files` is `undefined` when
 * the caller skipped the changed-files request, in which case only the totals
 * (from the pull request record) are returned.
 *
 * The client's own page cap outranks this tool's cuts when it really cut rows: a
 * changed-file list shorter than the pull request record's `fileCount` may be
 * missing files the tool never saw, while the row and character cuts only drop
 * rows that were seen — and in both cases the totals stay exact, because they
 * come from the pull request record, not from the table. A list that reached
 * `LIST_ITEM_LIMIT` while the record says that is all there is was not cut at
 * all.
 */
export function summarizePrReviewDiffStats(
  files: readonly ForgejoChangedFile[] | undefined,
  totals: { fileCount?: number; additions?: number; deletions?: number },
  budget: number = PR_REVIEW_DIFF_BUDGET,
): PrReviewBriefDiffStats {
  if (files === undefined) {
    return { ...totals };
  }
  const rows: PrReviewBriefFile[] = [];
  let used = 0;
  let cut: 'row-limit' | 'budget' | undefined;
  for (const file of files) {
    if (rows.length >= PR_REVIEW_MAX_DIFF_FILES) {
      cut = 'row-limit';
      break;
    }
    const row: PrReviewBriefFile = {
      path: file.filename,
      previousPath: file.previous_filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    };
    const cost = JSON.stringify(row).length + 1;
    if (used + cost > budget) {
      cut = 'budget';
      break;
    }
    used += cost;
    rows.push(row);
  }
  // The client's own page cap outranks every other cut (those rows were never
  // seen) — but only when it really cut something. The pull request record
  // carries the exact `changed_files`, so a table holding at least that many rows
  // passed the cap without losing a row, and the cap only explains a shorter one.
  // Comparing the length alone called a complete pull request with exactly
  // LIST_ITEM_LIMIT changed files truncated, the same mistake `getRepo`'s branch
  // cap avoids by reporting the cut it observed (see `repoDetailCapNote`).
  // Next comes this tool's deliberate cut. Last, the mismatch no cut explains:
  // the server returned fewer files than the pull request record's changed_files
  // without hitting any cap — observed from Forgejo 16 on a pull request whose
  // head branch was deleted after the merge, where the files endpoint silently
  // answers with a partial diff. Without the flag the table would read as
  // complete while listing less than fileCount.
  const fileCount = totals.fileCount;
  const capCut = files.length >= LIST_ITEM_LIMIT && (typeof fileCount !== 'number' || files.length < fileCount);
  const truncatedBy = capCut
    ? 'list-cap'
    : (cut ?? (typeof fileCount === 'number' && fileCount > rows.length ? 'server-partial' : undefined));
  return {
    ...totals,
    files: rows,
    listedFileCount: rows.length,
    truncated: truncatedBy !== undefined,
    truncatedBy,
  };
}

/**
 * The review picture: one entry per reviewer (their latest review) plus the
 * aggregate conclusion of the reviews that still count.
 *
 * A dismissed review was withdrawn and a stale one was invalidated by a later
 * commit, so neither states a current opinion. Both stay in `reviewers` with
 * their flags — the reader can see that the reviewer did look — but only current
 * reviews decide `summary`, the same rule `getPullRequestDetail` applies when it
 * counts approvals for a branch-protection requirement.
 */
export function summarizePrReviewStatus(
  reviews: readonly PullReview[],
  totalCount?: number,
): PrReviewBriefReviewStatus {
  const latestByReviewer = new Map<string, { position: number; review: PullReview }>();
  reviews.forEach((review, position) => {
    // A review whose user is gone (deleted account) cannot be attributed to a
    // reviewer, so it stays its own entry instead of collapsing every
    // unattributable review into one.
    const key = review.user?.login ?? `anonymous-review-${review.id ?? position}`;
    const previous = latestByReviewer.get(key);
    if (!previous || position > previous.position) {
      latestByReviewer.set(key, { position, review });
    }
  });
  const ordered = [...latestByReviewer.values()].sort((a, b) => a.position - b.position);
  const reviewers = ordered.map(({ review }): PrReviewBriefReviewer => ({
    reviewer: review.user?.login,
    state: review.state,
    reviewedAt: review.submitted_at ?? review.updated_at,
    reviewId: review.id,
    stale: review.stale === true ? true : undefined,
    dismissed: review.dismissed === true ? true : undefined,
  }));
  const current = ordered
    .map(({ review }) => review)
    .filter((review) => review.stale !== true && review.dismissed !== true);
  const approvals = current.filter((review) => review.state === 'APPROVED').length;
  const changesRequested = current.filter((review) => isChangesRequestedState(review.state)).length;
  return {
    reviewers,
    summary:
      reviews.length === 0
        ? 'no_reviews'
        : changesRequested > 0
          ? 'changes_requested'
          : approvals > 0
            ? 'approved'
            : 'awaiting_review',
    approvals,
    changesRequested,
    awaiting: current.length - approvals - changesRequested,
    // The review list is paged to the same shared cap as every other list, and a
    // reviewer whose only review fell off it would leave `reviewers` without a
    // word: the flag is what says the picture may be missing someone. With the
    // server's own count (`totalCount`) the flag is exact — a list holding
    // exactly LIST_ITEM_LIMIT reviews that the server also counts as all of them
    // is complete — and the length heuristic only stays for a server that
    // reported no total.
    truncated: isListTruncatedWithTotal(reviews, totalCount),
  };
}

/**
 * Runs `task` for every item with at most `limit` in flight, preserving nothing
 * but the caller's own ordering (the index is passed along for that). Kept local
 * because the MCP layer cannot reach the client's private copy, and mirrored
 * from the extension's review-comment controller on purpose: both fan out over
 * the same per-review endpoint.
 */
async function forEachInPool<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

/**
 * Every review's comments, in review order, plus how many reviews' comments
 * could not be read.
 *
 * One request per review is the only way to get them (see
 * `PR_REVIEW_COMMENT_FETCH_CONCURRENCY`), and a failure is absorbed per review
 * for the same reason `get_ci_failure_summary` absorbs an unreadable log: a
 * deleted review or one transient error must not discard the other reviews'
 * comments. The count is reported in the result instead, so the reader knows the
 * unresolved set may be incomplete.
 */
async function collectReviewComments(
  client: ForgejoClient,
  owner: string,
  repo: string,
  index: number,
  reviews: readonly PullReview[],
): Promise<{ comments: PullReviewComment[]; unreadableReviewCount: number }> {
  const perReview: PullReviewComment[][] = reviews.map(() => []);
  let unreadableReviewCount = 0;
  await forEachInPool(reviews, PR_REVIEW_COMMENT_FETCH_CONCURRENCY, async (review, position) => {
    if (typeof review.id !== 'number') {
      // Without an id the comment endpoint cannot be addressed, so this review's
      // comments are unknown rather than empty.
      unreadableReviewCount += 1;
      return;
    }
    try {
      perReview[position] = await client.getPullReviewComments(owner, repo, index, review.id);
    } catch (error) {
      // A cancelled call is not a per-review failure: absorbing it would let a
      // cancelled tool call come back as a successful partial brief. A timeout
      // stays a per-review problem (the other reviews are still useful).
      if (toApiError(error).kind === 'cancelled') {
        throw error;
      }
      unreadableReviewCount += 1;
    }
  });
  return { comments: perReview.flat(), unreadableReviewCount };
}

/** UTF-8 byte length, the unit the write budgets and the audit line report in. */
function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** SHA-256 of the body in hex — the audit line's content fingerprint (§8). */
function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** One audited write call, before `ms` and the outcome are known. */
type WriteAuditDraft = McpWriteAuditDraft;

/**
 * Structurally identical to the client's `ApiError` (`toApiError`), which is
 * consumed by value rather than imported so this file keeps only the client
 * import it already had.
 */
interface ApiErrorLike {
  kind: string;
  status?: number;
}

/**
 * One successful write, kept for the session's idempotency table (§6.2).
 *
 * `decision` is the whole of what the caller asked for — tool, target, review
 * id, body digest — and `sha256` is deliberately absent from an entry for a
 * body-less call: a body-less `COMMENT` review is a legitimate call, and `''`
 * would make it indistinguishable from a call that carried an empty body.
 * A `body === undefined` call therefore never matches one that carried text.
 */
interface WriteIdempotencyEntry {
  decision: WriteIdempotencyDecision;
  /** The `ok` payload, replayed verbatim when the same call comes back. */
  response: Record<string, unknown>;
  /** Completion time, for the TTL sweep. */
  at: number;
}

/** The identity of one logical write: what a retry has to reproduce exactly. */
interface WriteIdempotencyDecision {
  tool: McpWriteTool;
  target: string;
  reviewId?: number;
  /**
   * The action run a `cancel_action_run` call names. Like `reviewId` this is an
   * identity-only field: it never reaches the audit line (which has no run
   * field — the run number is already the `target`'s suffix and the endpoint
   * answers with no body to record), only the replay check.
   */
  runId?: number;
  sha256?: string;
}

/** What the session's idempotency table says about this call (§6.3). */
type WriteIdempotencyLookup =
  | { kind: 'proceed' }
  | { kind: 'replay'; response: Record<string, unknown> }
  | { kind: 'key-reuse'; key: string };

/**
 * The same key with the same target, review and body digest is a retry of a
 * call that already succeeded, and gets that call's result back; the same key
 * with anything different is a caller bug and is refused before any request.
 *
 * All three write tools share this table, so the tool name is part of the
 * identity: one key reused across the comment tool, the review tool and the
 * cancel tool is a reuse, not a replay of another tool's result.
 */
function resolveIdempotency(
  table: WriteIdempotencyTable,
  key: string | undefined,
  decision: WriteIdempotencyDecision,
): WriteIdempotencyLookup {
  if (key === undefined) {
    return { kind: 'proceed' };
  }
  const previous = table.lookup(key, Date.now());
  if (!previous) {
    return { kind: 'proceed' };
  }
  const same =
    previous.decision.tool === decision.tool &&
    previous.decision.target === decision.target &&
    previous.decision.reviewId === decision.reviewId &&
    previous.decision.runId === decision.runId &&
    previous.decision.sha256 === decision.sha256;
  return same ? { kind: 'replay', response: previous.response } : { kind: 'key-reuse', key };
}

/**
 * The body validation and the two gates, in the order the design fixes (§9):
 * an empty or oversized body is the caller's own error and is reported even
 * where writing is disabled, and only a session that both carries the
 * provenance marker **and** has the tool's switch on may proceed.
 *
 * Shared by both write tools rather than copied: the ordering is what the tests
 * assert (nothing is sent while a gate is closed), and a second copy of it is
 * exactly where the two tools would drift apart.
 */
async function validateWriteCall(
  workspaceContext: WorkspaceContextOptions,
  tool: McpWriteTool,
  body: string | undefined,
  options: { requireBody: boolean },
  audit: (result: string, bytes?: number, sha256?: string) => Promise<void>,
): Promise<{ kind: 'refused'; response: unknown } | { kind: 'ok'; body?: string; bytes?: number; digest?: string }> {
  const hasBody = typeof body === 'string';
  const bytes = hasBody ? utf8ByteLength(body) : undefined;
  const digest = hasBody ? sha256Hex(body) : undefined;

  if (options.requireBody && (!hasBody || body.trim() === '')) {
    await audit('refused:validation', bytes, digest);
    throw new Error(
      'body must be a non-empty review message for this event; the server rejects a body-less APPROVED or REQUEST_CHANGES review. Nothing was sent.',
    );
  }
  if (bytes !== undefined && bytes > MCP_WRITE_BODY_MAX_BYTES) {
    await audit('refused:validation', bytes, digest);
    throw new Error(
      `body is ${bytes} bytes, over the ${MCP_WRITE_BODY_MAX_BYTES}-byte limit of this tool; nothing was sent.`,
    );
  }

  const decision = decideWriteCall(tool, {
    writeTools: workspaceContext.writeTools ?? [],
    enabledTools: workspaceContext.enabledWriteTools ?? [],
  });
  if (decision !== 'allowed') {
    await audit(`refused:${writeRefusalReason(decision)}`, bytes, digest);
    return {
      kind: 'refused',
      response: {
        ok: false,
        refused: true,
        reason: decision,
        message: writeRefusalMessage(decision, tool),
      },
    };
  }
  return { kind: 'ok', ...(hasBody ? { body, bytes, digest } : {}) };
}

/**
 * One audit line for one write call, written through the host-supplied sink.
 *
 * A session with no sink (the headless child, or a unit test) records nothing —
 * there is nothing to record to — and a failing sink never fails the tool call:
 * the audit is a record *about* the call, not part of it. Both tools build the
 * record through this one function, so the field set cannot drift between them.
 */
function writeAuditor(workspaceContext: WorkspaceContextOptions, draft: WriteAuditDraft) {
  const started = Date.now();
  return async (result: string, ms = Date.now() - started): Promise<void> => {
    const sink = workspaceContext.writeAudit;
    if (!sink) {
      return;
    }
    try {
      await sink.record(writeAuditRecord(workspaceContext, draft, result, ms));
      sink.recordFilePath();
    } catch {
      // Swallowed on purpose: see above.
    }
  };
}

/**
 * The idempotency table of one MCP server instance, i.e. of one session
 * (`mcp/brokerServer.ts`: every connection gets its own server). 10 minutes and
 * 32 entries are the decided values (§6.2, §13.6) and are deliberately not
 * exposed in settings — nobody tunes this knob, and the refusal text already
 * tells the caller to wait.
 *
 * Capacity is enforced by dropping the oldest entry, and expiry is enforced on
 * read, so a session that makes one call and then goes quiet holds nothing
 * forever.
 */
class WriteIdempotencyTable {
  private readonly entries = new Map<string, WriteIdempotencyEntry>();

  get size(): number {
    return this.entries.size;
  }

  /** The live entry for a key, if any; expired entries are dropped on sight. */
  lookup(key: string, now: number): WriteIdempotencyEntry | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      return undefined;
    }
    if (now - entry.at >= WRITE_IDEMPOTENCY_TTL_MS) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Records a completed write, evicting the oldest entry when full. */
  store(key: string, entry: WriteIdempotencyEntry): void {
    // `Map` preserves insertion order, so the first key is the oldest.
    while (this.entries.size >= WRITE_IDEMPOTENCY_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) {
        break;
      }
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, entry);
  }
}

/** How long one completed write stays replayable, and how many are kept (§6.2). */
export const WRITE_IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;
export const WRITE_IDEMPOTENCY_MAX_ENTRIES = 32;

/**
 * `create_issue_comment`: the write tool of stage 1.
 *
 * Ordering matters and is asserted by the tests: the body is validated, then
 * both gates are evaluated, then `dryRun` short-circuits, then the idempotency
 * table answers, and only then is a request issued. So a switched-off tool
 * sends nothing, a dry run sends nothing, and a replay sends nothing — and all
 * three are still audited (§8 audits every call, including the refused ones).
 *
 * `table` is the session's, owned by `registerTools` (see the comment there):
 * this function is rebuilt for a call that carries an abort signal, so the
 * table cannot live here.
 */
function createIssueCommentWrite(
  client: ForgejoClient,
  workspaceContext: WorkspaceContextOptions,
  table: WriteIdempotencyTable,
) {
  return async function create_issue_comment(args: CreateIssueCommentArgs): Promise<unknown> {
    const dryRun = args.dryRun === true;
    const repoRef = `${args.owner}/${args.repo}`;
    const target = `${repoRef}#${args.index}`;
    const draft: WriteAuditDraft = {
      tool: 'create_issue_comment',
      repo: repoRef,
      target,
      dryRun,
      bytes: typeof args.body === 'string' ? utf8ByteLength(args.body) : undefined,
      sha256: typeof args.body === 'string' ? sha256Hex(args.body) : undefined,
    };
    const audit = writeAuditor(workspaceContext, draft);

    // Validation before the gates: an empty or oversized body is the caller's
    // own error and can be reported even where writing is disabled, and it
    // never reaches the network either way.
    const validated = await validateWriteCall(
      workspaceContext,
      'create_issue_comment',
      args.body,
      { requireBody: true },
      audit,
    );
    if (validated.kind === 'refused') {
      return validated.response;
    }

    if (dryRun) {
      // No request, and no idempotency entry: a dry run is not the operation, so
      // it must not make a later real call look like a replay (§7).
      await audit('ok');
      return {
        ok: true,
        dryRun: true,
        message: 'Dry run: nothing was sent to the server.',
        plan: {
          tool: 'create_issue_comment',
          // The same label the audit line uses, so the plan the user is shown
          // and the record of what happened name the instance identically.
          instance: writeInstanceLabel(workspaceContext),
          repo: repoRef,
          target,
          bodyCharacters: args.body.length,
          bytes: draft.bytes,
          sha256: draft.sha256,
          api: `POST /repos/${args.owner}/${args.repo}/issues/${args.index}/comments`,
        },
        note: 'A dry run proves nothing about the server accepting this call: a missing write scope (403), a locked or invisible issue (404/423), rate limiting and validation errors only appear on the real request.',
      };
    }

    const key = args.idempotencyKey;
    const lookup = resolveIdempotency(table, key, {
      tool: 'create_issue_comment',
      target,
      sha256: draft.sha256,
    });
    if (lookup.kind === 'replay') {
      await audit('duplicate');
      return {
        ok: true,
        duplicate: true,
        message: WRITE_IDEMPOTENCY_REPLAY_MESSAGE,
        result: lookup.response,
      };
    }
    if (lookup.kind === 'key-reuse') {
      await audit(`refused:${WRITE_IDEMPOTENCY_REUSE_REASON}`);
      throw new Error(writeIdempotencyReuseMessage(lookup.key));
    }

    try {
      const comment = await client.createIssueComment(args.owner, args.repo, args.index, validated.body as string);
      const response = {
        ok: true,
        id: comment.id,
        html_url: comment.html_url,
        message: 'The comment was created on the server; open html_url to read it there.',
      };
      if (key !== undefined) {
        table.store(key, {
          decision: { tool: 'create_issue_comment', target, sha256: draft.sha256 },
          response,
          at: Date.now(),
        });
      }
      await audit('ok');
      return response;
    } catch (error) {
      const status = (toApiError(error) as ApiErrorLike).status;
      await audit(status === undefined ? 'failed' : `http:${status}`);
      throw error;
    }
  };
}

/**
 * `submit_pull_review`: the write tool of stage 2.
 *
 * Same ordering as stage 1's tool, and the same shared helpers implement it
 * (`validateWriteCall` for the body and the two gates, `resolveIdempotency` for
 * the retry table, `writeAuditor` for the audit line), so the two tools cannot
 * drift apart on any of them. What is specific to this one:
 *
 * - The call needs a `reviewId`: `client.submitPullReview` submits an existing
 *   **pending** review (`POST /repos/{owner}/{repo}/pulls/{index}/reviews/{id}`,
 *   Forgejo's `SubmitPullReviewOptions` takes only `event` and `body`). The
 *   endpoint cannot answer "state conflict" for a review that was never
 *   started, so the review id is the one input that makes the call meaningful.
 * - `event` is validated against `PULL_REVIEW_EVENTS` before anything is sent —
 *   the schema does that for a call arriving over MCP, and the same list is what
 *   the dry run and the description use, so all three spell the verdict
 *   identically. The server leaves the review pending on an event it does not
 *   recognise, which is why guessing a synonym is not an option (§4.2).
 * - `APPROVED` and `REQUEST_CHANGES` require a body; a `COMMENT` review does
 *   not need one (it may carry the pending review's inline comments instead).
 */
function submitPullReviewWrite(
  client: ForgejoClient,
  workspaceContext: WorkspaceContextOptions,
  table: WriteIdempotencyTable,
) {
  return async function submit_pull_review(args: SubmitPullReviewArgs): Promise<unknown> {
    const dryRun = args.dryRun === true;
    const repoRef = `${args.owner}/${args.repo}`;
    const target = `${repoRef}#${args.index}`;
    const reviewId = args.reviewId;
    const event = args.event;
    const draft: WriteAuditDraft = {
      tool: 'submit_pull_review',
      repo: repoRef,
      target,
      // The review's own number travels beside the shared target, exactly as §8
      // ("review 再加 reviewId") asks; putting it inside `target` would change
      // the field's meaning for the other tool.
      reviewId,
      dryRun,
      bytes: typeof args.body === 'string' ? utf8ByteLength(args.body) : undefined,
      sha256: typeof args.body === 'string' ? sha256Hex(args.body) : undefined,
    };
    const audit = writeAuditor(workspaceContext, draft);

    const validated = await validateWriteCall(
      workspaceContext,
      'submit_pull_review',
      args.body,
      // The server refuses a body-less APPROVED / REQUEST_CHANGES review
      // (`preparePullReviewType`: `needsBody` stays true for both); COMMENT is
      // the only verdict that may carry no review message.
      { requireBody: event !== 'COMMENT' },
      audit,
    );
    if (validated.kind === 'refused') {
      return validated.response;
    }

    if (dryRun) {
      await audit('ok');
      return {
        ok: true,
        dryRun: true,
        message: 'Dry run: nothing was sent to the server.',
        plan: {
          tool: 'submit_pull_review',
          instance: writeInstanceLabel(workspaceContext),
          repo: repoRef,
          target,
          reviewId,
          event,
          bodyCharacters: args.body?.length ?? 0,
          bytes: draft.bytes,
          sha256: draft.sha256,
          api: `POST /repos/${args.owner}/${args.repo}/pulls/${args.index}/reviews/${reviewId}`,
          // The extra wording §9 stage 2 asks for, so the plan a user is shown
          // before approving says what the verdict actually means.
          consequence: PULL_REVIEW_EVENT_CONSEQUENCES[event],
        },
        note: 'A dry run proves nothing about the server accepting this call: a missing write scope (403), an invisible pull request or review (404), a review that is no longer pending (422) and rate limiting only appear on the real request.',
      };
    }

    const key = args.idempotencyKey;
    const lookup = resolveIdempotency(table, key, {
      tool: 'submit_pull_review',
      target,
      reviewId,
      sha256: draft.sha256,
    });
    if (lookup.kind === 'replay') {
      await audit('duplicate');
      return {
        ok: true,
        duplicate: true,
        message: WRITE_IDEMPOTENCY_REPLAY_MESSAGE,
        result: lookup.response,
      };
    }
    if (lookup.kind === 'key-reuse') {
      await audit(`refused:${WRITE_IDEMPOTENCY_REUSE_REASON}`);
      throw new Error(writeIdempotencyReuseMessage(lookup.key));
    }

    try {
      const review = await client.submitPullReview(args.owner, args.repo, args.index, reviewId, event, validated.body);
      const response = {
        ok: true,
        id: review.id,
        state: review.state,
        html_url: review.html_url,
        message: `The review was submitted as ${review.state ?? event} on the server; open html_url to read it there.`,
      };
      if (key !== undefined) {
        table.store(key, {
          decision: { tool: 'submit_pull_review', target, reviewId, sha256: draft.sha256 },
          response,
          at: Date.now(),
        });
      }
      await audit('ok');
      return response;
    } catch (error) {
      const status = (toApiError(error) as ApiErrorLike).status;
      await audit(status === undefined ? 'failed' : `http:${status}`);
      throw error;
    }
  };
}

/**
 * `cancel_action_run`: the first write tool of the second batch (§4.1, §13.3).
 *
 * Same ordering and the same shared helpers as the two first-batch tools
 * (`validateWriteCall` for the two gates, `resolveIdempotency` for the retry
 * table, `writeAuditor` for the audit line). What is specific to this one:
 *
 * - It has **no body**. Forgejo's cancel endpoint takes the run as a path
 *   parameter and answers `204` with no content, so there is nothing to size or
 *   digest: `validateWriteCall` is asked for no body at all
 *   (`requireBody: false`), and the audit line therefore carries neither `bytes`
 *   nor `sha256` — absent, not zero, which is the same rule a body-less
 *   `COMMENT` review already follows.
 * - The endpoint is **idempotent-safe by the server's own design**: it cancels
 *   the pending or running jobs and answers 204, and a run that already
 *   finished is left unchanged and still answered with 204. That is why a
 *   repeated cancel inside the idempotency window may safely replay — the
 *   retry is the same logical action and a retry that forgot the key would
 *   still not double-cancel anything.
 * - The success text is careful for the same reason: a 204 does **not** prove
 *   that this call cancelled anything, only that the server accepted it, so the
 *   result says so instead of claiming a state change the tool cannot observe.
 *   `list_action_runs` is the authority on the run's status, as it is on the
 *   run number this tool takes.
 */
function cancelActionRunWrite(
  client: ForgejoClient,
  workspaceContext: WorkspaceContextOptions,
  table: WriteIdempotencyTable,
) {
  return async function cancel_action_run(args: CancelActionRunArgs): Promise<unknown> {
    const dryRun = args.dryRun === true;
    const repoRef = `${args.owner}/${args.repo}`;
    const target = `${repoRef}#${args.runId}`;
    const runId = args.runId;
    const draft: WriteAuditDraft = {
      tool: 'cancel_action_run',
      repo: repoRef,
      target,
      dryRun,
      // No body fields: this call carries no text, and §8 wants them absent
      // rather than zero or an empty digest.
    };
    const audit = writeAuditor(workspaceContext, draft);

    const validated = await validateWriteCall(
      workspaceContext,
      'cancel_action_run',
      undefined,
      { requireBody: false },
      audit,
    );
    if (validated.kind === 'refused') {
      return validated.response;
    }

    if (dryRun) {
      // No request and no idempotency entry: a dry run is not the operation
      // (§7), and the ordering — validation, gates, then dry run — is the same
      // one the other two tools follow, so a dry run cannot probe past a gate.
      await audit('ok');
      return {
        ok: true,
        dryRun: true,
        message: 'Dry run: nothing was sent to the server.',
        plan: {
          tool: 'cancel_action_run',
          instance: writeInstanceLabel(workspaceContext),
          repo: repoRef,
          target,
          runId,
          api: `POST /repos/${args.owner}/${args.repo}/actions/runs/${runId}/cancel`,
          consequence:
            'Pending or running jobs of this run are cancelled; a run that has already finished is left unchanged by the server, and this call changes nothing else.',
        },
        note: 'A dry run proves nothing about the server accepting this call: a missing write scope (403), an invisible or unknown run (404), an instance older than Forgejo 16 (404, the Actions endpoints arrived in 16.0.0) and rate limiting only appear on the real request.',
      };
    }

    const key = args.idempotencyKey;
    const lookup = resolveIdempotency(table, key, {
      tool: 'cancel_action_run',
      target,
      runId,
    });
    if (lookup.kind === 'replay') {
      await audit('duplicate');
      return {
        ok: true,
        duplicate: true,
        message: WRITE_IDEMPOTENCY_REPLAY_MESSAGE,
        result: lookup.response,
      };
    }
    if (lookup.kind === 'key-reuse') {
      await audit(`refused:${WRITE_IDEMPOTENCY_REUSE_REASON}`);
      throw new Error(writeIdempotencyReuseMessage(lookup.key));
    }

    try {
      await client.cancelActionRun(args.owner, args.repo, runId);
      const response = {
        ok: true,
        id: runId,
        target,
        message:
          'The server accepted the cancel request for this run (HTTP 204) and nothing else was changed by this call. ' +
          'The endpoint also answers 204 for a run that had already finished, where it cancels nothing — check the run in the Forgejo web UI, or call list_action_runs, to see what its state actually is.',
      };
      if (key !== undefined) {
        table.store(key, {
          decision: { tool: 'cancel_action_run', target, runId },
          response,
          at: Date.now(),
        });
      }
      await audit('ok');
      return response;
    } catch (error) {
      const status = (toApiError(error) as ApiErrorLike).status;
      await audit(status === undefined ? 'failed' : `http:${status}`);
      throw error;
    }
  };
}

/**
 * What each accepted verdict means, in the words §9 stage 2 asks the tool to
 * carry: an approval can satisfy branch protection, and a change request blocks
 * the pull request until it is dismissed or superseded.
 */
const PULL_REVIEW_EVENT_CONSEQUENCES: Readonly<Record<PullReviewEvent, string>> = {
  COMMENT: 'A COMMENT review leaves a public review record without approving or blocking the pull request.',
  APPROVED:
    'This counts as a formal approval of the pull request and may satisfy the repository branch protection requirements.',
  REQUEST_CHANGES:
    'This counts as a formal request for changes and blocks the pull request until it is dismissed or superseded by a later review.',
};

/**
 * Plain async handlers behind the MCP tools, exported for unit tests: they
 * return the untruncated payload and let errors propagate. The MCP
 * registration (registerTools) adds truncation and error rendering on top.
 */
export function buildToolHandlers(
  client: ForgejoClient,
  workspaceContext: WorkspaceContextOptions = {},
  writeIdempotency: WriteIdempotencyTable = new WriteIdempotencyTable(),
) {
  return {
    // Reads the state file fresh on every call: the workspace changes while
    // this long-lived process runs, and a cached answer would quietly go
    // stale. Needs no HTTP, so the client's abort signal does not apply.
    get_workspace_repository: () =>
      resolveWorkspaceRepository(workspaceContext.stateFile, workspaceContext.instanceUrl, workspaceContext.instanceId),

    // The three write tools of the two batches (stages 1 and 2, then the
    // second batch's cancel). Everything that makes them safe lives in
    // createIssueCommentWrite / submitPullReviewWrite / cancelActionRunWrite:
    // the two gates, the body validation, the dry run, the session idempotency
    // table and the audit line.
    create_issue_comment: createIssueCommentWrite(client, workspaceContext, writeIdempotency),

    submit_pull_review: submitPullReviewWrite(client, workspaceContext, writeIdempotency),

    cancel_action_run: cancelActionRunWrite(client, workspaceContext, writeIdempotency),

    // The scope assertion stays in a synchronous arrow so a half-specified
    // scope throws (rather than rejecting) before any request is issued. The
    // keyword goes to the server on both branches (see the note above), so no
    // row the server matched is discarded afterwards.
    //
    // Both branches answer the client's paged shape (`items` plus the server's
    // optional `totalCount`) instead of only `.items`: the total is what lets the
    // truncation note compare the rows against the server's own count instead of
    // guessing from the length. `getUserIssues` answers rows only (the generated
    // wrapper drops `X-Total-Count`), so that branch reports the same shape with
    // the total honestly absent.
    list_issues: (args: ListIssuesArgs): Promise<PagedList<ForgejoIssue>> => {
      assertCompleteRepoScope(args.owner, args.repo);
      return args.owner && args.repo
        ? client.getRepoIssues(args.owner, args.repo, args.state ?? 'open', args.query)
        : client.getUserIssues(args.state ?? 'open', args.query).then((items) => ({ items }));
    },

    get_issue: async (args: IssueRefArgs) => {
      // The timeline endpoint is shared between issues and PRs; the client
      // method is named after its PR usage but serves issue comments too. Its
      // total-aware form is read so the truncation note can compare the rows
      // against the server's own comment count instead of guessing from the
      // length; the rows keep the shape callers already read (`comments`), with
      // the count beside them.
      const [issue, comments] = await Promise.all([
        client.getIssueDetail(args.owner, args.repo, args.index),
        client.getPullRequestCommentsAndTimelineWithTotal(args.owner, args.repo, args.index),
      ]);
      return { issue, comments: comments.items, commentsTotalCount: comments.totalCount };
    },

    // Same paged shape as `list_issues`, for the same reason; the instance-wide
    // branch has no total to report (see there).
    list_pull_requests: (args: ListIssuesArgs): Promise<PagedList<ForgejoPullRequest>> => {
      assertCompleteRepoScope(args.owner, args.repo);
      return args.owner && args.repo
        ? client.getRepoPullRequests(args.owner, args.repo, args.state ?? 'open', args.query)
        : client.getUserPullRequests(args.state ?? 'open', args.query).then((items) => ({ items }));
    },

    get_pull_request: async (args: IssueRefArgs) => {
      // Both lists are read in their total-aware form for the same reason as
      // `get_issue` above: the rows keep their shape and the server's own count
      // sits beside them, so a changed-file or commit list that reached the
      // shared cap is only announced as cut when the server says rows are
      // missing.
      const [pullRequest, files, commits] = await Promise.all([
        client.getPullRequestDetail(args.owner, args.repo, args.index),
        client.getPullRequestFilesWithTotal(args.owner, args.repo, args.index),
        client.getPullRequestCommitsWithTotal(args.owner, args.repo, args.index),
      ]);
      return {
        pullRequest,
        files: files.items,
        filesTotalCount: files.totalCount,
        commits: commits.items,
        commitsTotalCount: commits.totalCount,
      };
    },

    get_pr_timeline: (args: IssueRefArgs) =>
      client.getPullRequestCommentsAndTimelineWithTotal(args.owner, args.repo, args.index),

    // One page of up to `limit` rows. `before` is the API's own page cursor
    // (the server keeps rows updated at exactly that instant; see
    // `getNotifications`), so a caller can fetch the next page with the
    // `updated_at` of the oldest row it received and skip that repeated row. The
    // client does not page to `LIST_ITEM_LIMIT` here — the page size is the
    // caller's own choice — so `PAGED_LISTS` stays silent for this tool (as it
    // does for `list_action_runs`, whose page is also caller-sized) and the
    // description, not a note, tells the caller what a full page means. The
    // client's `PagedList` is passed through rather than only its rows: the
    // optional total is the server's count of matching threads.
    list_notifications: (args: ListNotificationsArgs): Promise<PagedList<ForgejoNotification>> =>
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
      client.getActionRunArtifactsWithTotal(args.owner, args.repo, args.runId),

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

    list_branches: (args: RepoRefArgs) => client.getRepoBranchesWithTotal(args.owner, args.repo),

    list_tags: (args: RepoRefArgs) => client.getRepoTagsWithTotal(args.owner, args.repo),

    list_commits: (args: ListCommitsArgs) => client.getRepoBranchCommits(args.owner, args.repo, args.branch),

    get_file_history: (args: FileContentArgs) =>
      client.getFileHistoryWithTotal(args.owner, args.repo, args.path, args.ref),

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

    list_pull_reviews: (args: IssueRefArgs) => client.listPullReviewsWithTotal(args.owner, args.repo, args.index),

    // One call replaces get_pull_request + get_pr_diff + get_pr_timeline +
    // list_pull_reviews for the purpose of starting a review. It reads the pull
    // request, its changed files and its reviews in parallel, then one comment
    // request per review (the endpoint is per review), and hands back only what
    // a review needs to begin: the header, the diff's shape, the review
    // conclusions and the unresolved inline comments. Everything it returns is
    // pre-sized (see the PR_REVIEW_* constants), so callTool's own truncation
    // never has to cut the comments the way it would cut a raw diff.
    get_pr_review_brief: async (args: PrReviewBriefArgs) => {
      const [pullRequest, files, reviews] = await Promise.all([
        client.getPullRequestDetail(args.owner, args.repo, args.index),
        // The per-file table is the one piece a caller can skip: the totals come
        // from the pull request record either way, so a brief that only needs the
        // review state saves the changed-files request.
        args.includeDiffStats === false
          ? Promise.resolve(undefined)
          : client.getPullRequestFiles(args.owner, args.repo, args.index),
        // Read with the server's own review count so `reviewStatus.truncated` is
        // exact: a pull request with exactly `LIST_ITEM_LIMIT` reviews is not cut.
        client.listPullReviewsWithTotal(args.owner, args.repo, args.index),
      ]);
      const { comments, unreadableReviewCount } = await collectReviewComments(
        client,
        args.owner,
        args.repo,
        args.index,
        reviews.items,
      );
      return {
        pullRequest: {
          number: pullRequest.number,
          title: pullRequest.title,
          state: pullRequest.state,
          draft: pullRequest.draft === true,
          merged: pullRequest.merged === true,
          author: pullRequest.user?.login,
          baseBranch: pullRequest.base?.ref,
          headBranch: pullRequest.head?.ref,
          mergeable: pullRequest.mergeable,
          mergeBlockers: pullRequest.mergeBlockers ?? [],
          protectionUnknown: pullRequest.protectionUnknown === true ? true : undefined,
        } satisfies PrReviewBriefPullRequest,
        diffStats: summarizePrReviewDiffStats(files, {
          fileCount: pullRequest.changed_files,
          additions: pullRequest.additions,
          deletions: pullRequest.deletions,
        }),
        reviewStatus: summarizePrReviewStatus(reviews.items, reviews.totalCount),
        unresolvedComments: { ...summarizeUnresolvedComments(comments), unreadableReviewCount },
      } satisfies PrReviewBrief;
    },

    whoami: () => client.getCurrentUser(),

    list_releases: (args: RepoRefArgs) => client.getRepoReleasesWithTotal(args.owner, args.repo),

    list_labels: (args: RepoRefArgs) => client.getRepoLabelsWithTotal(args.owner, args.repo),

    list_milestones: (args: RepoRefArgs) => client.getRepoMilestonesWithTotal(args.owner, args.repo),

    // The client's `PagedList` is passed through (not only its rows) so the
    // truncation note can read the server's own count; the total is optional
    // because an older or proxied server omits `X-Total-Count`.
    list_my_repos: (): Promise<PagedList<ForgejoRepository>> => client.getUserRepositories(),
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

/**
 * One paged list inside a tool result.
 *
 * `field` names the row array (`RESULT_FIELD` when the result *is* the array);
 * `totalField`, when set, names the server's own row count beside it — the
 * client's `PagedList.totalCount`, present only when the server sent
 * `X-Total-Count` — which turns the truncation judgement from a length guess
 * into an exact comparison; `label` is how the note names the list (defaults to
 * `field`).
 */
export interface PagedListSpec {
  field: string;
  totalField?: string;
  label?: string;
}

/** The whole tool result is the `PagedList` the client filled by paging. */
const PAGED_RESULT: readonly PagedListSpec[] = [{ field: 'items', totalField: 'totalCount', label: RESULT_FIELD }];
/** No list in the tool result is paged, so nothing in it can have been cut off. */
const NO_PAGED_LISTS: readonly PagedListSpec[] = [];

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
 *
 * Every paged list carries the server's own count beside its rows, either in
 * `totalCount` (the whole result is the client's `PagedList`) or in the
 * `totalField` named here (a list wrapped inside a larger result, e.g.
 * `get_issue`'s `comments`), so `listTruncationNote` compares rows against that
 * count (exact) and falls back to the length heuristic only when a server
 * reported no total.
 */
const PAGED_LISTS: Record<ToolName, readonly PagedListSpec[]> = {
  get_workspace_repository: NO_PAGED_LISTS,
  // A write returns one object, not a list; the paged-list note must not fire.
  create_issue_comment: NO_PAGED_LISTS,
  submit_pull_review: NO_PAGED_LISTS,
  cancel_action_run: NO_PAGED_LISTS,
  list_issues: PAGED_RESULT,
  get_issue: [{ field: 'comments', totalField: 'commentsTotalCount' }],
  list_pull_requests: PAGED_RESULT,
  get_pull_request: [
    { field: 'files', totalField: 'filesTotalCount' },
    { field: 'commits', totalField: 'commitsTotalCount' },
  ],
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
  // get_pr_review_brief does read paged lists (changed files, reviews) and both
  // now carry their server total, but neither is returned as-is: the diff table
  // is pre-sized by this tool's own budget and says which cut applied in
  // `diffStats.truncatedBy` (including the client's own list cap), and
  // `reviewStatus.reviewers` holds one entry per reviewer, so its length says
  // nothing about the review-list cap the result reports exactly in
  // `reviewStatus.truncated`. A note built from those lengths would tell a
  // caller to narrow a query this tool does not have.
  get_pr_review_brief: NO_PAGED_LISTS,
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
 * A note for the paged lists of `pagedLists` that are incomplete, or an empty
 * string.
 *
 * Every paged client method stops at `LIST_ITEM_LIMIT`; without this the result
 * looks complete and a caller cannot tell that more rows exist. Lists are
 * reported wherever they sit in the payload: several tools return an object
 * wrapping one (`get_issue` carries `comments`, `get_pull_request` carries
 * `files` and `commits`), and a capped list inside it would otherwise go
 * unannounced.
 *
 * Whether a list is incomplete is exact whenever the result carries the server's
 * own count (the client's `PagedList.totalCount`, read from `X-Total-Count`):
 * the list is short exactly when fewer rows arrived than the server holds. Only a
 * result without a total falls back to the length heuristic, and the note says
 * "possibly" for it instead of claiming a cut it cannot prove — a complete list
 * that happened to hold exactly `LIST_ITEM_LIMIT` rows was called truncated by
 * its length alone, and an overshooting read (a server that clamps the page size,
 * so the client stops mid-page) was reported as "truncated at 500 items" while
 * holding more rows than that.
 *
 * `canNarrow` decides what the caller is told to do about it: a tool with no
 * filter and no paging has no way to fetch the rest, and pointing such a caller
 * at a query it cannot pass is worse than saying the answer is incomplete.
 */
export function listTruncationNote(
  value: unknown,
  pagedLists: readonly PagedListSpec[],
  options: { canNarrow: boolean },
): string {
  const truncated = truncatedListFields(value, pagedLists);
  if (truncated.length === 0) {
    return '';
  }
  const counts = truncated.map(describeTruncatedList).join(', ');
  const exact = truncated.every((list) => list.total !== undefined);
  const heading = exact ? 'list truncated' : 'list possibly truncated';
  return options.canNarrow
    ? `\n(${heading}: ${counts}; narrow the query to see the rest)`
    : `\n(${heading}: ${counts}; the result ${exact ? 'is' : 'may be'} incomplete and this tool has no filter or paging, so the remaining items cannot be fetched through the MCP tools — read them in the Forgejo web UI, or use a narrower tool for the same data)`;
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

/** One incomplete paged list: how the note names it and the two counts it reports. */
interface TruncatedList {
  name: string;
  returned: number;
  total?: number;
}

/**
 * The lists in `pagedLists` that are incomplete, with the counts the note reports.
 *
 * Only the lists a client method pages are considered (see `PAGED_LISTS`), so a
 * complete single-page list of the same length is not reported as cut off. A
 * list whose result carries the server's total is judged by that total; one
 * without it falls back to the length heuristic and keeps its total unknown.
 */
function truncatedListFields(value: unknown, pagedLists: readonly PagedListSpec[]): TruncatedList[] {
  const fields = value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
  const truncated: TruncatedList[] = [];
  for (const { field, totalField, label } of pagedLists) {
    const rows = field === RESULT_FIELD ? value : fields?.[field];
    if (!Array.isArray(rows)) {
      continue;
    }
    const rawTotal = totalField === undefined ? undefined : fields?.[totalField];
    const total = typeof rawTotal === 'number' ? rawTotal : undefined;
    if (!isListTruncatedWithTotal(rows, total)) {
      continue;
    }
    truncated.push({ name: label ?? field, returned: rows.length, total });
  }
  return truncated;
}

/**
 * How the note says how much of one list came back: the two real counts when the
 * server reported its own, and the row count with the cap it passed otherwise.
 */
function describeTruncatedList({ name, returned, total }: TruncatedList): string {
  return total === undefined
    ? `${name} (${returned} rows returned, at or above the ${LIST_ITEM_LIMIT}-row list cap)`
    : `${name} (${returned} of ${total} rows)`;
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
 * The tool surface: read-only tools over the paginated client methods (which
 * carry their own MAX_ITEMS caps) plus the three gated write tools. Tool names
 * and descriptions are English literals on purpose — they are read by LLM
 * agents, not by users.
 */
export function registerTools(
  server: McpServer,
  client: ForgejoClient,
  workspaceContext: WorkspaceContextOptions = {},
): void {
  const handlers = buildToolHandlers(client, workspaceContext);
  // One idempotency table per `registerTools` call, i.e. per MCP server
  // instance, i.e. per session (`mcp/brokerServer.ts`: every connection gets its
  // own server). It is created *here* and passed in, not inside
  // `buildToolHandlers`, because that function is rebuilt per call whenever the
  // SDK supplies an abort signal — a table built there would be discarded
  // between two calls of the same session, which is exactly the duplication the
  // key exists to prevent.
  const writeIdempotency = new WriteIdempotencyTable();
  // A cancelled tool call should abort its HTTP requests. The SDK passes the signal
  // in the tool callback's second argument, and `withSignal` is cheap, so the
  // handlers are rebuilt around a signalling client instead of threading a
  // parameter through all of them.
  const handlersFor = (extra?: { signal?: AbortSignal }) =>
    extra?.signal ? buildToolHandlers(client.withSignal(extra.signal), workspaceContext, writeIdempotency) : handlers;
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

  // The first write tool (stage 1 of docs/design/mcp-write-tools-confirmation.md).
  // Registering it unconditionally is deliberate: the tool list stays stable, and
  // a call that is not allowed comes back as a refusal naming the setting to turn
  // on (§9 stage 0 fixes that semantic). It carries WRITE_TOOL_ANNOTATIONS, not
  // `readOnly`, so VS Code shows its per-call confirmation dialog — which is the
  // first of the two gates, and the reason `readOnlyHint` must stay unset. The
  // same holds for every write tool registered below.
  server.registerTool(
    'create_issue_comment',
    {
      description:
        'Write operation: add a comment to an issue or pull request. This changes server state — it creates a public, permanent record on the instance under the account the configured token belongs to. It appends exactly one comment and changes nothing else (no title, no labels, no state, no merge), and it cannot be undone by this tool; a wrong comment has to be edited or deleted in the Forgejo web UI. It needs a token with write access to issues (Forgejo answers 403 without it; the extension cannot fix that for this session), 404 when the issue or pull request is not visible to the token, and 422 when the server rejects the text. Every call is confirmed by the user in VS Code first, and it is additionally gated by the extension setting `forgejoToolkit.mcpWriteTools.createIssueComment`, which is off by default; when it is off — or when this session was not established by the Forgejo Toolkit extension host — the call returns a plain explanation naming the setting instead of writing. Idempotency: pass an `idempotencyKey` and reuse the same value when retrying the same logical operation; within 10 minutes a repeat with the same key, target and body replays the earlier result instead of creating a second comment, while the same key with a different target or body is refused. Forgejo itself has no idempotency key on this endpoint, so a retry that does not reuse the key does create a second comment. Before a batch of comments (or any comment the user has not read yet), call this tool once with `dryRun: true`, show the user the returned plan, and only then send the real calls one at a time; a dry run proves the shape of the call, not that the server will accept it.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: z.number().int().positive().describe('Issue or pull request number to comment on.'),
        body: z
          .string()
          .describe(
            `Comment text (Markdown), at most ${MCP_WRITE_BODY_MAX_BYTES} bytes. Must not be empty or whitespace-only. It is written verbatim and is publicly visible on the instance; never include credentials or private data the instance should not hold.`,
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            'Retry key for this logical write. Reuse the identical value when retrying the same operation; use a new one for a different comment. Within 10 minutes the same key with the same target and body returns the earlier result instead of writing again.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'When true, report what would be sent (target, body length, digest) without sending it. Default: false. Recommended before a batch, or whenever the user has not read the exact text yet.',
          ),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (args, extra) => callTool('create_issue_comment', () => handlersFor(extra).create_issue_comment(args)),
  );

  // The second write tool (stage 2 of docs/design/mcp-write-tools-confirmation.md).
  // Registered unconditionally for the same reason as stage 1's: the tool list
  // stays stable and a call that is not allowed comes back as a refusal naming
  // its own setting. It carries WRITE_TOOL_ANNOTATIONS, not `readOnly`, so VS
  // Code asks before every call. The `event` enum is the validated list — the
  // schema is the only place that can stop a model from inventing a synonym,
  // and a synonym the server does not recognise leaves the review pending.
  server.registerTool(
    'submit_pull_review',
    {
      description:
        'Write operation: submit an existing pending pull request review with a verdict. This changes server state — the review becomes a public, permanent record on the instance under the account the configured token belongs to, and it cannot be undone by this tool (it can only be superseded by a later review, or dismissed by a repository admin). `reviewId` must name a review that is still **pending** on the pull request; this tool submits it, so submitting one that is already submitted is refused by the server with 422, and starting a review is a different operation this tool does not perform. `event` is the verdict, spelled exactly as Forgejo stores it: `COMMENT` (a review record with no verdict), `APPROVED` (a formal approval, which may satisfy the repository branch protection requirements) or `REQUEST_CHANGES` (a formal request for changes). Only `COMMENT` may omit `body`; `APPROVED` and `REQUEST_CHANGES` require a non-empty review message, because the server rejects them without one. It needs a token with write access to pull requests (Forgejo answers 403 without it; the extension cannot fix that for this session), 404 when the pull request or the review is not visible to the token, and 422 when the review is no longer pending, the event is unknown or the body is empty where it is required. Every call is confirmed by the user in VS Code first, and it is additionally gated by the extension setting `forgejoToolkit.mcpWriteTools.submitPullReview`, which is off by default; when it is off — or when this session was not established by the Forgejo Toolkit extension host — the call returns a plain explanation naming the setting instead of writing. Idempotency: pass an `idempotencyKey` and reuse the same value when retrying the same logical operation; within 10 minutes a repeat with the same key, target, reviewId and body replays the earlier result instead of submitting twice, while the same key with a different target, review or body is refused. Forgejo itself has no idempotency key on this endpoint, so a retry that does not reuse the key posts a second review. Before a batch of reviews (or any review the user has not read yet), call this tool once with `dryRun: true`, show the user the returned plan and what the verdict means, and only then send the real calls one at a time; a dry run proves the shape of the call, not that the server will accept it.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: z.number().int().positive().describe('Pull request number.'),
        reviewId: z
          .number()
          .int()
          .positive()
          .describe(
            'Id of the pending review to submit, as returned when the review was started (list_pull_reviews shows the reviews of a pull request, including its pending one).',
          ),
        event: z
          .enum(PULL_REVIEW_EVENTS)
          .describe(
            'The verdict, exactly one of: COMMENT, APPROVED, REQUEST_CHANGES. No other spelling is accepted, and a value the server does not recognise leaves the review pending. Use APPROVED only when the user asked for an approval: it counts as a formal approval and may satisfy branch protection.',
          ),
        body: z
          .string()
          .optional()
          .describe(
            `The review message (Markdown), at most ${MCP_WRITE_BODY_MAX_BYTES} bytes. Required for APPROVED and REQUEST_CHANGES, optional for COMMENT. It is stored verbatim and is publicly visible on the instance; never include credentials or private data the instance should not hold.`,
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            'Retry key for this logical write. Reuse the identical value when retrying the same operation; use a new one for a different review or verdict. Within 10 minutes the same key with the same target, review and body returns the earlier result instead of submitting again.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'When true, report what would be sent (target, review id, verdict and what it means, body length, digest) without sending it. Default: false. Recommended before a batch, or whenever the user has not read the exact text yet.',
          ),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (args, extra) => callTool('submit_pull_review', () => handlersFor(extra).submit_pull_review(args)),
  );

  // The third write tool, and the first of the second batch
  // (docs/design/mcp-write-tools-confirmation.md §4.1 / §13.3). Registered
  // unconditionally, like the two before it: the tool list stays stable and a
  // call that is not allowed comes back as a refusal naming its own setting. It
  // carries WRITE_TOOL_ANNOTATIONS — no `readOnlyHint` (so VS Code asks before
  // every call) and no `destructiveHint` either way, which is the honest shape
  // for a call that stops running work on the server.
  server.registerTool(
    'cancel_action_run',
    {
      description:
        'Write operation: cancel a pending or running Actions workflow run. This changes server state — it stops the run on the instance, so pending or running jobs are cancelled and the run ends as `cancelled` under the account the configured token belongs to. It is a destructive-ish action on the server rather than an append: it does not create a visible record, it changes the state of work that is already running, and it cannot be undone by this tool (the run has to be triggered again, which this tool does not do and which is a separate operation). It changes nothing else about the run. `runId` is the run to cancel, as `list_action_runs` reports it (Forgejo stores this run number as `index_in_repo`); the server answers 204 and leaves a run that has already finished — cancelled, failed, skipped or succeeded — unchanged, so a 204 means the request was accepted, not that this call cancelled anything. It needs a token with write access to the repository Actions (Forgejo answers 403 without it; the extension cannot fix that for this session), 404 when the run is not visible to the token or belongs to another repository, and 404 on an instance older than Forgejo 16, where the Actions endpoints do not exist. Every call is confirmed by the user in VS Code first, and it is additionally gated by the extension setting `forgejoToolkit.mcpWriteTools.cancelActionRun`, which is off by default and independent of the comment and review switches; when it is off — or when this session was not established by the Forgejo Toolkit extension host — the call returns a plain explanation naming the setting instead of cancelling. Idempotency: pass an `idempotencyKey` and reuse the same value when retrying the same logical operation; within 10 minutes a repeat with the same key and the same run replays the earlier result instead of sending a second cancel, while the same key with a different run is refused. A retry that does not reuse the key still cannot cancel the same run twice: the server leaves a finished run unchanged. Because cancelling is immediate and visible to everyone watching the run, call this tool once with `dryRun: true` and show the user the returned plan before the real call; a dry run proves the shape of the call, not that the server will accept it.',
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        runId: z
          .number()
          .int()
          .positive()
          .describe(
            'Number of the workflow run to cancel, as list_action_runs reports it (Forgejo stores this run number as `index_in_repo`). Use list_action_runs first to confirm the run is still running or pending: cancelling a run that has already finished changes nothing.',
          ),
        idempotencyKey: z
          .string()
          .optional()
          .describe(
            'Retry key for this logical write. Reuse the identical value when retrying the same cancellation; use a new one for a different run. Within 10 minutes the same key with the same run returns the earlier result instead of sending a second cancel.',
          ),
        dryRun: z
          .boolean()
          .optional()
          .describe(
            'When true, report what would be sent (target, run number, endpoint and what cancelling means) without sending it. Default: false. Recommended before a real cancel, since the effect is immediate and visible to everyone watching the run.',
          ),
      },
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async (args, extra) => callTool('cancel_action_run', () => handlersFor(extra).cancel_action_run(args)),
  );

  server.registerTool(
    'list_issues',
    {
      description:
        "List issues. With owner and repo, lists the issues of that repository, optionally keyword-filtered; without them, lists issues across the instance that involve the authenticated user, with the same keyword filter. The filter is applied by the server, which matches the keyword against the issue title, its body and its comments (and an issue reference such as #123); it does not match the author. The result is `{ items, totalCount }`: `items` holds the rows and `totalCount` is the server's own row count when it reports one, which is what tells a list cut off at the shared cap from a complete one. The instance-wide listing reports no total.",
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
      description:
        "Get a single issue by number, including its comments. The result is `{ issue, comments, commentsTotalCount }`, and every comment entry carries `assets` (the attachments the issues API returned for it, an empty array when it links none) and `attachmentsUnavailable: true` when that extra read failed — in which case `assets` is unknown rather than empty. `commentsTotalCount` is the server's own comment count when it reports one, which is what tells a comment list cut off at the shared cap from a complete one.",
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
        "List pull requests. With owner and repo, lists the pull requests of that repository, optionally keyword-filtered; without them, lists pull requests across the instance that involve the authenticated user, with the same keyword filter. The filter is applied by the server, which matches the keyword against the pull request title, its body and its comments (and an issue reference such as #123); it does not match the author. The result is `{ items, totalCount }`: `items` holds the rows and `totalCount` is the server's own row count when it reports one, which is what tells a list cut off at the shared cap from a complete one. The instance-wide listing reports no total.",
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
        "Get a single pull request by number, including changed files, commits, merge blockers, and status checks. The result is `{ pullRequest, files, filesTotalCount, commits, commitsTotalCount }`: the attachment fields live under `pullRequest`, not at the top of the result. Attachments are read from the issues API, which is the only endpoint that exposes them, so `pullRequest` carries `assets` (the attachment metadata the issues API returned, possibly undefined) and `attachmentsUnavailable: true` when that extra read failed — in which case `assets` is unknown rather than empty. `filesTotalCount`/`commitsTotalCount` are the server's own counts when it reports them, which is what tells a list cut off at the shared cap from a complete one.",
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
      description:
        "Get the comment and event timeline of a pull request (review comments, status changes, etc.). The result is `{ items, totalCount }`: `items` holds the timeline rows and `totalCount` is the server's own row count when it reports one, which is what tells a timeline cut off at the shared cap from a complete one. Every comment entry carries `assets` (the attachments the issues API returned for it, an empty array when it links none) and `attachmentsUnavailable: true` when that extra read failed — in which case `assets` is unknown rather than empty.",
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
      description: `List one page of Forgejo notifications for the authenticated user. A page holds at most \`limit\` notifications (default 50, max 100); a page that fills the limit is not necessarily the whole list. To fetch the next page, call the tool again with \`before\` set to the \`updated_at\` of the oldest notification in the previous page; the server keeps rows updated at exactly that instant (\`updated_unix <= before\`), so that boundary notification comes back in the next page as well and the caller must skip the row it already has. The result is \`{ items, totalCount }\`: \`items\` holds the page, and \`totalCount\` is the server's count of matching notifications when it reports one, which says how much is left beyond this page.`,
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
      description:
        "List the artifacts of an Actions workflow run (metadata and download URLs, not contents). The result is `{ items, totalCount }`: `items` holds the artifacts and `totalCount` is the server's own artifact count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
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
        'Get the decoded text content of a file in a repository. Large files are truncated to ~10 KB by the tool result budget. A path that names a directory (use list_repo_contents to list its entries), a symlink, or a submodule is not a file and is reported as an error naming what the entry actually is (a symlink with its link target, a submodule with its git URL, either way pointing at the web UI) instead of returning content; a path whose contents listing comes back empty is reported as an error naming both causes it can have — an empty directory, or an empty repository, which answers an empty listing for every path — because the response cannot tell them apart; a file whose payload the instance withholds (above its contents API payload limit) is answered with a successful notice naming its size instead of its content.',
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
        'List the entries at a path in a repository (default: repository root): files, directories, symlinks and submodules. A directory path answers with its children; a file path answers that one entry (whose `content`, when the API sends it, is base64 — use get_file_content for decoded text). An empty result is an empty directory or an empty repository: Forgejo answers an empty list for every path once the repository has no content, so treat an empty listing as "nothing here", not as proof that the path is a directory.',
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
      description:
        "List the branches of a repository. The result is `{ items, totalCount }`: `items` holds the branches and `totalCount` is the server's own branch count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_branches', () => handlersFor(extra).list_branches(args)),
  );

  server.registerTool(
    'list_tags',
    {
      description:
        "List the tags of a repository. The result is `{ items, totalCount }`: `items` holds the tags and `totalCount` is the server's own tag count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
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
      description: `List the commits that touched a file, paged up to the shared list cap of ${LIST_ITEM_LIMIT} commits. The result is \`{ items, totalCount }\`: \`items\` holds the commits and \`totalCount\` is the server's own commit count for that file when it reports one — so a history holding exactly ${LIST_ITEM_LIMIT} commits is complete, while fewer rows than the total is reported as incomplete. \`ref\` selects the revision to walk from, not a narrower slice of the history, so this tool has no filter or page to fetch the rest.`,
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
      description:
        "List the reviews of a pull request with their conclusions (APPROVED, CHANGES_REQUESTED, etc.). The result is `{ items, totalCount }`: `items` holds the reviews and `totalCount` is the server's own review count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
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
    'get_pr_review_brief',
    {
      description: `Start reviewing a pull request in one call instead of get_pull_request + get_pr_diff + get_pr_timeline + list_pull_reviews. It returns: the pull request header (title, state, draft/merged, author, base and head branches, mergeable and the merge blockers); the diff statistics — changed-file count and total added/deleted lines from the pull request record, plus a per-file table of additions and deletions (line counts only, never the diff text); each reviewer's latest conclusion with its time and an aggregate summary; and the unresolved inline review comments with file path, line, author, time and body. Deliberately left out, because they are large and rarely needed to begin: the description and the commit list (use get_pull_request), the diff text (use get_pr_diff — a hunk can only be judged from the changed lines), the discussion timeline (use get_pr_timeline), and the raw review list (use list_pull_reviews when reviewStatus is not enough). Everything here is pre-sized to a shared budget: diffStats.truncated/truncatedBy say whether the per-file table was cut ('row-limit' or 'budget' by this tool, 'list-cap' when the client's shared 500-row list cap was reached while the pull request record's fileCount says more files exist, 'server-partial' when the server itself returned fewer files than the record and no cap explains it — in every case fileCount/additions/deletions stay exact); reviewStatus.truncated says the review list is incomplete — the server's own review count decides it when the server reports one, so a pull request with exactly the shared cap of reviews is not announced as cut, and the cap is the fallback otherwise; and unresolvedComments.total/returned/truncated/truncatedBy say how many unresolved comments exist and whether the count cap (${PR_REVIEW_MAX_COMMENTS}) or the character budget stopped the list, with bodyTruncated on a comment whose body was cut to ${PR_REVIEW_MAX_COMMENT_LENGTH} characters. The newest comments survive a cut. unresolvedComments.unreadableReviewCount is non-zero when a review's comment list could not be read, so the unresolved set may be missing entries. Set includeDiffStats to false to skip the changed-files request when only the file/line totals and the review state are needed.`,
      inputSchema: {
        owner: ownerRequiredSchema,
        repo: repoRequiredSchema,
        index: pullIndexSchema,
        includeDiffStats: z
          .boolean()
          .optional()
          .describe(
            'Include the per-file diff table (default: true). Set false to skip the changed-files request; the file/line totals still come from the pull request record.',
          ),
      },
      annotations: readOnly,
    },
    async (args, extra) => callTool('get_pr_review_brief', () => handlersFor(extra).get_pr_review_brief(args)),
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
      description:
        "List the releases of a repository. The result is `{ items, totalCount }`: `items` holds the releases and `totalCount` is the server's own release count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_releases', () => handlersFor(extra).list_releases(args)),
  );

  server.registerTool(
    'list_labels',
    {
      description:
        "List the labels of a repository. The result is `{ items, totalCount }`: `items` holds the labels and `totalCount` is the server's own label count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_labels', () => handlersFor(extra).list_labels(args)),
  );

  server.registerTool(
    'list_milestones',
    {
      description:
        "List the open milestones of a repository. The result is `{ items, totalCount }`: `items` holds the milestones and `totalCount` is the server's own milestone count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
      inputSchema: { owner: ownerRequiredSchema, repo: repoRequiredSchema },
      annotations: readOnly,
    },
    async (args, extra) => callTool('list_milestones', () => handlersFor(extra).list_milestones(args)),
  );

  server.registerTool(
    'list_my_repos',
    {
      description:
        "List the repositories of the authenticated user (owned and collaborated). The result is `{ items, totalCount }`: `items` holds the repositories and `totalCount` is the server's own count when it reports one, which is what tells a list cut off at the shared cap from a complete one.",
      inputSchema: {},
      annotations: readOnly,
    },
    async (_args, extra) => callTool('list_my_repos', () => handlersFor(extra).list_my_repos()),
  );
}
