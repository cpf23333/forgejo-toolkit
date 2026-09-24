import * as fs from 'fs';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { buildUrl, client as baseClient, encodePathSegment } from '@cpf23333-forgejo-toolkit/shared/request';
import { LIST_ITEM_LIMIT, MAX_REPO_FILE_SEARCH_RESULTS } from '@cpf23333-forgejo-toolkit/shared/limits';
import { toApiError, requestContextFor } from './errors-core';
import { getForgejoClientHost } from './clientHost';
import { assertActionsSupported } from './serverVersion';
import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import type { Client, RequestConfig, RequestFetch, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
import {
  createCurrentUserRepo,
  getTree,
  getVersion,
  issueAddSubscription,
  issueAddTime,
  issueCheckSubscription,
  issueCreateComment,
  issueCreateIssue,
  issueCreateIssueAttachment,
  issueCreateIssueCommentAttachment,
  issueCreateIssueDependencies,
  issueDelete,
  issueDeleteComment,
  issueDeleteCommentReaction,
  issueDeleteIssueAttachment,
  issueDeleteIssueCommentAttachment,
  issueDeleteIssueReaction,
  issueDeleteStopWatch,
  issueDeleteSubscription,
  issueDeleteTime,
  issueEditComment,
  issueEditIssue,
  issueGetCommentReactions,
  issueGetCommentsAndTimeline,
  issueGetIssue,
  issueGetIssueReactions,
  issueGetMilestonesList,
  issueListIssueCommentAttachments,
  issueListIssueDependencies,
  issueListIssues,
  issueListLabels,
  issuePostCommentReaction,
  issuePostIssueReaction,
  issueRemoveIssueDependencies,
  issueReplaceLabels,
  issueResetTime,
  issueSearchIssues,
  issueStartStopWatch,
  issueStopStopWatch,
  issueTrackedTimes,
  listActionRuns,
  actionRun,
  listActionRunJobs,
  listActionRunArtifacts,
  repoGetActionJobLogs,
  dispatchWorkflow,
  cancelActionRun,
  downloadActionArtifact,
  deleteActionRun,
  notifyGetList,
  notifyReadList,
  notifyReadThread,
  repoCompareDiff,
  repoCreateBranch,
  repoCreatePullRequest,
  repoCreatePullReview,
  repoCreatePullReviewComment,
  repoCreateRelease,
  repoCreateReleaseAttachment,
  repoCreateTag,
  repoDeleteBranch,
  repoDeletePullReview,
  repoDeletePullReviewComment,
  repoDeleteRelease,
  repoDeleteReleaseAttachment,
  repoDeleteTag,
  repoDownloadPullDiffOrPatch,
  repoEditPullRequest,
  repoEditRelease,
  repoGet,
  repoGetAllCommits,
  repoGetAssignees,
  repoGetBranchProtection,
  repoGetCombinedStatusByRef,
  repoGetContents,
  repoGetContentsList,
  repoGetPullRequest,
  repoGetPullRequestCommits,
  repoGetPullRequestFiles,
  repoGetPullReviewComments,
  repoListBranches,
  repoListPullRequests,
  repoListPullReviews,
  repoListReleases,
  repoListTags,
  repoMergePullRequest,
  repoSearch,
  repoSubmitPullReview,
  userCurrentListRepos,
  userGet,
  userGetCurrent,
  userGetStopWatches,
  userSearch,
  renderMarkdown as apiRenderMarkdown,
} from '@cpf23333-forgejo-toolkit/api';

import type {
  ActionArtifact,
  ActionRun,
  ActionRunJob,
  AddTimeOption,
  Attachment,
  Commit,
  CreateBranchRepoOption,
  CreateIssueOption,
  CreatePullRequestOption,
  CreatePullReviewComment,
  CreateReleaseOption,
  CreateRepoOption,
  CreateTagOption,
  DispatchWorkflowRun,
  EditIssueOption,
  EditPullRequestOption,
  EditReleaseOption,
  GitEntry,
  IssueMeta,
  Label,
  Milestone,
  PullReview,
  PullReviewComment,
  Reaction,
  Repository,
  StopWatch,
  TimelineComment,
  TrackedTime,
  User,
  WatchInfo,
} from '@cpf23333-forgejo-toolkit/api';
import type {
  ForgejoActionRunJob,
  ForgejoActionArtifact,
  ForgejoActionRunList,
  ForgejoBranch,
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoContentEntry,
  ForgejoIssue,
  ForgejoIssueAttachment,
  ForgejoIssueDetail,
  MergeBlocker,
  ForgejoNotification,
  ForgejoPullRequest,
  ForgejoPullRequestDetail,
  ForgejoRelease,
  ForgejoRepoDetail,
  ForgejoRepository,
  ForgejoTag,
  ForgejoUser,
} from './types';

// Attachments uploaded through the extension are always referenced in the
// comment body as `/attachments/<uuid>` links (the EasyMDE upload flow inserts
// `![image](/attachments/{uuid})`), so only comments matching this pattern
// need their attachment list fetched.
const ATTACHMENT_REFERENCE_REGEX = /\/attachments\/[0-9a-fA-F-]{36}/;

const TREE_CACHE_TTL_MS = 60_000;

// Forgejo's default MAX_RESPONSE_ITEMS is 50 and larger limits are silently
// clamped server-side, so paginate with a page size the server accepts.
const PAGE_SIZE = 50;
// Safety bound on the total item count (not the page count), so a server that
// clamps the page size cannot shrink the overall result window, and a
// misbehaving server cannot keep us fetching forever.
const MAX_ITEMS = LIST_ITEM_LIMIT;
// Re-exported for the MCP layer, which names a capped list; the constant itself
// lives in the shared package so the webview cannot drift from the host.
export { LIST_ITEM_LIMIT };
// Raw payload caps: CI logs are loaded fully into memory; artifacts stream to
// disk and only carry a large defensive cap against unbounded writes.
const MAX_JOB_LOG_LENGTH = 10 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
// Guard for the recursive git tree loop against servers that ignore the
// pagination params and keep returning the same page with truncated=true.
const MAX_TREE_PAGES = 50;
// A query like "e" matches thousands of paths; the browser renders plain rows, so
// the response is capped and the truncation flag tells the user why the list stops.
// The number lives in the shared package because the webview states it too.
export const MAX_SEARCH_RESULTS = MAX_REPO_FILE_SEARCH_RESULTS;
// Branches and recent commits carried by `getRepoDetail`, whose caller (the MCP
// `get_repo` tool) must be able to say that the two lists are capped: without
// that, a branch past the first ten reads as a branch that does not exist.
export const REPO_DETAIL_LIST_LIMIT = 10;

/**
 * `getRepoDetail`'s result: the detail plus, for each capped list, whether it
 * was actually cut. The flags are `true` only when the extra row requested
 * beyond `REPO_DETAIL_LIST_LIMIT` came back, so `false`/absent means the list is
 * complete. They are optional so a caller that builds a `ForgejoRepoDetail` by
 * hand (tests, fixtures) stays valid.
 */
export interface ForgejoRepoDetailWithCaps extends ForgejoRepoDetail {
  branchesTruncated?: boolean;
  recentCommitsTruncated?: boolean;
}

/** Per-request timeout: a reachable-but-unresponsive instance must not hang. */
export const API_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The logging surface ForgejoClient uses. Structural (not the extension's
 * Logger class) so headless consumers — the MCP server process — can supply
 * a console-backed implementation without pulling in the `vscode` module.
 */
export interface ClientLogger {
  isDebugEnabled(): boolean;
  debug(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

/**
 * Longer budget for large buffered downloads (CI logs up to 10 MB, PR diffs):
 * the generic 30 s cap aborts them mid-transfer on slow networks. Artifact
 * streaming uses an idle watchdog instead of a total cap (see
 * downloadActionArtifactToFile).
 */
export const API_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

interface TreeCacheEntry {
  value: GitEntry[];
  /**
   * Whether the cached read stopped early. Kept with the value: a truncated
   * tree is cached too (see `_getRepoTree`), and answering a later caller with
   * `truncated: false` would present an incomplete tree as exhaustive.
   */
  truncated: boolean;
  expiresAt: number;
}

// Shared across ForgejoClient instances: the view provider constructs a
// client per message, so an instance field would die with each request and
// the TTL would never pay off. Entries are keyed by origin + token hash +
// repo + ref, so same-origin accounts never share cached trees. Bounded with
// simple oldest-first eviction.
const treeCache = new Map<string, TreeCacheEntry>();
const MAX_TREE_CACHE_ENTRIES = 50;

/** Clear the shared git-tree cache. Exported for tests. */
export function clearTreeCache(): void {
  treeCache.clear();
}

/**
 * How many git trees the shared cache currently holds. Exported for tests, which
 * cannot otherwise observe that inserting purges the entries whose TTL has
 * passed.
 */
export function treeCacheSizeForTest(): number {
  return treeCache.size;
}

/**
 * Drops the tree entries whose TTL has passed, so the count cap measures live
 * entries.
 *
 * Expiry used to be checked only on a hit, so up to MAX_TREE_CACHE_ENTRIES
 * expired trees — each a repository's whole blob-path array — stayed reachable
 * until a count-based eviction happened to pick them; the contents memo carries
 * the same fix in `purgeExpiredRepoContents`.
 */
function purgeExpiredTreeCache(now: number): void {
  for (const [key, entry] of treeCache) {
    if (entry.expiresAt <= now) {
      treeCache.delete(key);
    }
  }
}

/**
 * Short-lived memo of `getRepoContents` answers, for the repository file
 * provider: VS Code calls `stat` and then `readFile` for the same URI, and
 * because that provider builds a ForgejoClient per call, the second call used to
 * download the same blob again. The memo is module-level for exactly that
 * reason, and keyed by instance + repo + path + ref so it cannot answer a
 * different file.
 *
 * Never consulted for a client bound to an AbortSignal (`withSignal`), whose
 * result belongs to one MCP tool call, and never populated with a failure.
 */
interface RepoContentsCacheEntry {
  value: ForgejoContentEntry[];
  expiresAt: number;
  /**
   * Serialized size of `value`. Counting entries alone is not enough: the
   * contents API answers with base64 file bodies, so a handful of near-limit
   * blobs is hundreds of megabytes held for the life of the process.
   */
  bytes: number;
}

const repoContentsCache = new Map<string, RepoContentsCacheEntry>();
const REPO_CONTENTS_TTL_MS = 5_000;
const MAX_REPO_CONTENTS_CACHE_ENTRIES = 64;
/**
 * Byte budget for the contents memo. The largest single response the client
 * asks for is a ~10 MiB blob (~14 MB once base64-encoded by the API), so the
 * budget holds a couple of those plus the small entries the provider actually
 * re-reads.
 */
export const REPO_CONTENTS_CACHE_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Running total of `bytes` over `repoContentsCache`. Maintained on insert, on
 * eviction and on the expired-entry purge, so the budget cannot drift from the
 * map it measures.
 */
let repoContentsCacheBytes = 0;

/**
 * Joins the parts of a cache key so no two different requests can produce the
 * same key. A plain separator character is not enough: `|` is legal in a git ref
 * name and in a file name, so the path `a|b` with ref `main` and the path `a`
 * with ref `b|main` would both render as `...|a|b|main` and alias one entry.
 * Prefixing each part with its length makes the encoding injective.
 */
function cacheKeyFor(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

/** Clear the shared repo-contents memo. Exported for tests. */
export function clearRepoContentsCache(): void {
  repoContentsCache.clear();
  repoContentsCacheBytes = 0;
}

/**
 * How many bytes the contents memo currently holds. Exported for tests, which
 * cannot otherwise observe the running total the budget is enforced against.
 */
export function repoContentsCacheBytesForTest(): number {
  return repoContentsCacheBytes;
}

/** Serialized size of a cached payload, in bytes. */
function byteSizeOf(value: unknown): number {
  const serialized = JSON.stringify(value) ?? '';
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(serialized) : serialized.length;
}

/**
 * Drops the entries whose TTL has passed, whoever reads or writes next.
 *
 * Expiry used to be checked only on a hit, so a cache filled with large payloads
 * kept them — and their bytes — until the next request for that exact key or
 * until a count-based eviction happened to pick them. Counting them out at insert
 * time keeps both caps measuring live entries.
 */
function purgeExpiredRepoContents(now: number): void {
  for (const [key, entry] of repoContentsCache) {
    if (entry.expiresAt <= now) {
      repoContentsCache.delete(key);
      repoContentsCacheBytes -= entry.bytes;
    }
  }
}

/**
 * Stores one contents answer, evicting oldest-first until both the entry count
 * and the byte budget hold. The oldest entry is dropped before the new one is
 * added, so a single payload larger than the budget still leaves the cache with
 * exactly that payload rather than an empty map.
 *
 * An entry that alone exceeds the whole budget is answered to its caller but
 * never retained (the same guard the avatar and attachment-image caches use):
 * caching it would evict every other entry and still leave the total above the
 * budget.
 */
function rememberRepoContents(key: string, value: ForgejoContentEntry[]): void {
  const now = Date.now();
  purgeExpiredRepoContents(now);
  const bytes = byteSizeOf(value);
  const previous = repoContentsCache.get(key);
  if (previous) {
    repoContentsCache.delete(key);
    repoContentsCacheBytes -= previous.bytes;
  }
  if (bytes > REPO_CONTENTS_CACHE_MAX_BYTES) {
    return;
  }
  while (
    repoContentsCache.size > 0 &&
    (repoContentsCache.size >= MAX_REPO_CONTENTS_CACHE_ENTRIES ||
      repoContentsCacheBytes + bytes > REPO_CONTENTS_CACHE_MAX_BYTES)
  ) {
    const oldest = repoContentsCache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    const evicted = repoContentsCache.get(oldest);
    repoContentsCache.delete(oldest);
    repoContentsCacheBytes -= evicted?.bytes ?? 0;
  }
  repoContentsCache.set(key, { value, expiresAt: now + REPO_CONTENTS_TTL_MS, bytes });
  repoContentsCacheBytes += bytes;
}

/**
 * Drop the shared repository-content memos (the recursive git tree and the
 * contents memo).
 *
 * Both are short-lived, so this is not about size: a mutation that changes a
 * repository's content behind a still-valid key would keep serving pre-mutation
 * bytes. The merge path below calls it, and so does the host's Refresh command,
 * which is the user's escape hatch when a tree or file looks stale.
 */
export function invalidateRepoContentCaches(): void {
  clearTreeCache();
  clearRepoContentsCache();
}

/**
 * Server origin detected for a configured instance, keyed by that instance's
 * origin, and the response shapes already proven to need no rewriting.
 *
 * Both are module-level for the same reason as `treeCache`: the view provider
 * constructs a ForgejoClient per message, so per-instance state dies with each
 * request and the scan/copy would run again on every response. Keyed by
 * configured origin, so two accounts on different instances never share a
 * verdict. Both memos are small — one entry per configured instance origin, one
 * per response shape — and the shape memo is capped at `MAX_ORIGIN_MEMO_ENTRIES`.
 */
const detectedOriginByConfigured = new Map<string, string>();
const noRewriteShapes = new Set<string>();
const MAX_ORIGIN_MEMO_ENTRIES = 64;

/** Records a payload shape as needing no rewrite, keeping the memo bounded. */
function rememberShape(shape: string): void {
  while (noRewriteShapes.size >= MAX_ORIGIN_MEMO_ENTRIES) {
    const oldest = noRewriteShapes.values().next().value;
    if (oldest === undefined) {
      break;
    }
    noRewriteShapes.delete(oldest);
  }
  noRewriteShapes.add(shape);
}

/** Clear the shared URL-rewrite memoization. Exported for tests. */
export function clearDetectedServerOrigins(): void {
  detectedOriginByConfigured.clear();
  noRewriteShapes.clear();
}

/**
 * A cheap structural fingerprint of a JSON response: property names and array
 * lengths, sampling at most `SHAPE_SAMPLE_ITEMS` items and `SHAPE_MAX_DEPTH`
 * levels. Two responses of the same endpoint share it, so the verdict "this
 * shape carries no URL to rewrite" is reusable.
 *
 * Sampling — rather than hashing every value — is what makes it cheaper than the
 * scan it replaces on a 500-item list, and it stays faithful because a verdict
 * is only reused when the remote server answered the same shape as before: a
 * response that suddenly carries URLs is a different login/instance and has its
 * own `configuredOrigin` key.
 */
const SHAPE_SAMPLE_ITEMS = 2;
const SHAPE_MAX_DEPTH = 4;

function _shapeFingerprint(value: unknown, depth = 0): string {
  if (depth > SHAPE_MAX_DEPTH) {
    return '...';
  }
  if (Array.isArray(value)) {
    const sampled = value
      .slice(0, SHAPE_SAMPLE_ITEMS)
      .map((item) => _shapeFingerprint(item, depth + 1))
      .join(',');
    return `[${value.length}:${sampled}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${key}=${_shapeFingerprint(item, depth + 1)}`).join(';')}}`;
  }
  return typeof value;
}

/**
 * Merge two per-commit statuses of the same file into the net status for the
 * whole compare range. `undefined` means the changes cancel out. Order
 * matters: an added file that is later modified is still a new file (the base
 * side has nothing to fetch), while a removed file that is later re-added
 * exists at both ends with different content. A file that is gone at the head
 * of the range is a removal no matter what happened earlier (e.g. modified
 * then removed) — otherwise the diff editor tries to fetch the head side and
 * shows an empty file on the 404. Only used for /compare output, which never
 * reports 'renamed'/'copied' (see getPullRequestFilesFromCompare), so neither
 * needs a branch here.
 */
function mergeCompareStatuses(existing: string, next: string): string | undefined {
  if (existing === 'added' && next === 'removed') {
    return undefined;
  }
  if (existing === 'removed' && next === 'added') {
    return 'modified';
  }
  if (next === 'removed') {
    return 'removed';
  }
  if (existing === 'added' || existing === 'removed') {
    return existing;
  }
  // Prefer a specific status over the generic 'changed'.
  if (existing === 'changed') {
    return next;
  }
  return existing;
}

export interface MentionUserItem {
  value: string;
  name: string;
  full_name?: string;
  avatar_url?: string;
}

export interface MentionIssueItem {
  value: string;
  title: string;
  state?: string;
  user?: ForgejoUser;
  is_pull?: boolean;
}

export interface MentionSearchResult {
  users: MentionUserItem[];
  issues: MentionIssueItem[];
}

/**
 * Adds an abort signal to a request config. Exported so the merge can be asserted
 * directly: a mocked HTTP layer rebuilds the Request and drops the caller signal,
 * which hides this from an end-to-end test.
 */

/** Adds a Node fetch dispatcher (proxy agent) to a request config. */
export function withDispatcher<TRequestData>(
  config: RequestConfig<TRequestData>,
  dispatcher?: unknown,
  fetchImpl?: RequestFetch,
): RequestConfig<TRequestData> {
  return dispatcher ? { ...config, dispatcher, ...(fetchImpl ? { fetchImpl } : {}) } : config;
}

// Set once at activation: the editor setting or environment, resolved to a proxy
// agent plus the fetch implementation that understands it. Per-client
// dispatchers (should they ever exist) win over this.
let defaultRequestDispatcher: unknown;
let defaultRequestFetch: RequestFetch | undefined;

/** Installs the proxy dispatcher and its matching fetch for every client. */
export function setDefaultRequestDispatcher(dispatcher?: unknown, fetchImpl?: RequestFetch): void {
  defaultRequestDispatcher = dispatcher;
  defaultRequestFetch = fetchImpl;
}

/**
 * Merges the signals that can abort one request: the caller's, the per-client
 * one (MCP tool cancellation) and the request timeout. Each of them must still
 * be able to abort, so they are combined rather than one overriding the others.
 */
export function combineRequestSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return undefined;
  }
  return active.length === 1 ? active[0] : AbortSignal.any(active);
}

/**
 * The signal one request runs under.
 *
 * `API_REQUEST_TIMEOUT_MS` is a default for requests nobody bounded, not a
 * ceiling: a caller that passes its own signal (a long artifact or log download)
 * replaces it. The client-level signal is added on top either way, so a
 * cancelled MCP tool call aborts even though the timeout would otherwise have
 * been the only signal.
 */
export function requestSignalFor(callerSignal?: AbortSignal, clientSignal?: AbortSignal): AbortSignal {
  return combineRequestSignals([
    callerSignal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
    clientSignal,
  ]) as AbortSignal;
}

export function withAbortSignal<TRequestData>(
  config: RequestConfig<TRequestData>,
  signal?: AbortSignal,
): RequestConfig<TRequestData> {
  return signal ? { ...config, signal } : config;
}
export class ForgejoClient {
  private readonly configuredOrigin: string;
  /** Node fetch dispatcher (undici ProxyAgent) for hosts behind a proxy. */
  private readonly requestDispatcher?: unknown;
  /** The fetch that understands `requestDispatcher` (the bundled undici). */
  private readonly requestFetch?: RequestFetch;
  /** Abort signal for this client's requests; set by `withSignal` (MCP tool calls). */
  private readonly abortSignal?: AbortSignal;
  private detectedServerOrigin: string | undefined;
  private readonly syncApiUrlsToInstanceUrl: boolean;
  // Distinguishes same-origin accounts in the shared tree cache without
  // embedding the raw token in cache keys.
  private readonly tokenCacheKey: string;

  constructor(
    private url: string,
    private token: string,
    private logger?: ClientLogger,
    syncApiUrlsToInstanceUrl?: boolean,
    options?: { signal?: AbortSignal; dispatcher?: unknown; fetch?: RequestFetch },
  ) {
    this.abortSignal = options?.signal;
    this.requestDispatcher = options?.dispatcher;
    this.requestFetch = options?.fetch;
    this.configuredOrigin = new URL(this.url.replace(/\/$/, '')).origin;
    this.syncApiUrlsToInstanceUrl = syncApiUrlsToInstanceUrl ?? true;
    this.tokenCacheKey = createHash('sha256').update(token).digest('hex').slice(0, 16);
  }

  getCurrentUser(): Promise<ForgejoUser> {
    return userGetCurrent({ client: this._client() }) as Promise<ForgejoUser>;
  }

  /** Raw `/api/v1/version` string (e.g. "1.21.5"), undefined when the server omits it. */
  async getServerVersion(): Promise<string | undefined> {
    const result = await getVersion({ client: this._client() });
    return (result as { version?: string }).version;
  }

  /**
   * The Actions API only exists on Forgejo/Gitea ≥ 1.19; older instances
   * answer a bare 404. Gate on the probed server version (fail-open when
   * unknown) so users get an actionable message instead.
   */
  private _assertActions(): void {
    assertActionsSupported(this.url, getForgejoClientHost().t);
  }

  /**
   * Fetches every page of a list endpoint. The server may silently clamp the
   * requested limit (MAX_RESPONSE_ITEMS), so the first page's length — not
   * PAGE_SIZE — defines the effective page size: only a shorter later page
   * (or an empty one) means the list is exhausted. X-Total-Count is not
   * available on all endpoints. The safety bound caps the total item count
   * (not the page count), so a clamped page size does not shrink the overall
   * result window.
   *
   * `label` names the list in the completion log: `API_REQUEST_TIMEOUT_MS`
   * bounds one request, not the whole paged operation, so the request count is
   * the only visible measure of what a multi-page read cost the caller (and
   * how close it came to the item cap).
   */
  private async _fetchAllPages<T>(
    fetchPage: (page: number) => Promise<T[] | null | undefined>,
    options: { label: string; shortPageMarksEnd?: boolean },
  ): Promise<T[]> {
    const shortPageMarksEnd = options.shortPageMarksEnd ?? true;
    // Endpoints that filter rows *after* the page was read from the database can
    // return an empty page while later pages still hold rows (a whole page of
    // code comments is dropped, for instance). Those callers pass
    // `shortPageMarksEnd: false` and tolerate one such gap: paging stops only
    // after this many consecutive empty pages, which keeps the look-ahead
    // bounded (one extra request in the normal case).
    const maxConsecutiveEmptyPages = shortPageMarksEnd ? 1 : 2;
    const all: T[] = [];
    let effectivePageSize: number | undefined;
    let page = 1;
    let emptyPages = 0;
    // Guards against servers that ignore the page param and keep returning
    // the first page (same pattern as the git-tree loop below): without it,
    // duplicates would accumulate up to MAX_ITEMS.
    let previousFirstItemKey: string | undefined;
    // Number of requests actually issued. `page` cannot serve as this count:
    // the loop increments it after the last full page, so a read stopped by
    // MAX_ITEMS would report one request too many.
    let requests = 0;
    while (all.length < MAX_ITEMS) {
      const items = (await fetchPage(page)) ?? [];
      requests++;
      const firstItemKey = items.length > 0 ? JSON.stringify(items[0]) : undefined;
      if (firstItemKey !== undefined && firstItemKey === previousFirstItemKey) {
        break;
      }
      previousFirstItemKey = firstItemKey;
      all.push(...items);
      if (page === 1) {
        effectivePageSize = items.length;
      }
      if (items.length === 0) {
        emptyPages++;
        if (emptyPages >= maxConsecutiveEmptyPages) {
          break;
        }
        page++;
        continue;
      }
      emptyPages = 0;
      // A short page normally means the last page; callers that filter after
      // paging turn that heuristic off and keep going.
      if (shortPageMarksEnd && items.length < (effectivePageSize ?? PAGE_SIZE)) {
        break;
      }
      page++;
    }
    this.logger?.debug(`[pages] ${options.label}: ${requests} request(s), ${all.length} item(s)`);
    return all;
  }

  async getUserStopWatches(): Promise<StopWatch[]> {
    const watches = await this._fetchAllPages(
      (page) => userGetStopWatches({ page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'stop watches' },
    );
    return watches as StopWatch[];
  }

  async getUserRepositories(): Promise<ForgejoRepository[]> {
    const repos = await this._fetchAllPages(
      (page) => userCurrentListRepos({ page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'repositories' },
    );
    return repos as ForgejoRepository[];
  }

  createUserRepo(data: CreateRepoOption): Promise<Repository> {
    return createCurrentUserRepo(data, { client: this._client() });
  }

  async getUserIssues(state: string = 'open', query?: string): Promise<ForgejoIssue[]> {
    const issues = await this._fetchAllPages(
      (page) =>
        issueSearchIssues(
          {
            state: state as 'open' | 'closed' | 'all',
            type: 'issues',
            // /repos/issues/search is unfiltered by default: without these flags
            // the server returns every issue in every repository the token can
            // see. The dashboard tab promises the user's own items ("assigned to
            // you" / "related to you"), so scope the query explicitly.
            created: true,
            assigned: true,
            mentioned: true,
            review_requested: true,
            // The keyword goes to the server here too, so both `list_issues`
            // branches filter with the same matcher (the issue indexer: title,
            // body and comments). Filtering the returned rows locally instead
            // dropped every issue that matched only through a comment — see
            // mcp/tools.ts.
            ...(query ? { q: query } : {}),
            page,
            limit: PAGE_SIZE,
          },
          { client: this._client() },
        ),
      { label: 'user issues' },
    );
    return issues as ForgejoIssue[];
  }

  async getUserPullRequests(state: string = 'open', query?: string): Promise<ForgejoPullRequest[]> {
    const pulls = await this._fetchAllPages(
      (page) =>
        issueSearchIssues(
          {
            state: state as 'open' | 'closed' | 'all',
            type: 'pulls',
            // Same default-unfiltered caveat as getUserIssues.
            created: true,
            assigned: true,
            mentioned: true,
            review_requested: true,
            // Same server-side keyword as getUserIssues.
            ...(query ? { q: query } : {}),
            page,
            limit: PAGE_SIZE,
          },
          { client: this._client() },
        ),
      { label: 'user pull requests' },
    );
    return pulls as ForgejoPullRequest[];
  }

  searchRepositories(query: string, limit: number = 20): Promise<ForgejoRepository[]> {
    return repoSearch({ q: query, limit }, { client: this._client() }).then(
      (result) => (result?.data ?? []) as ForgejoRepository[],
    );
  }

  searchIssues(query: string, state: string = 'open', limit: number = 20): Promise<ForgejoIssue[]> {
    return issueSearchIssues(
      { q: query, state: state as 'open' | 'closed' | 'all', type: 'issues', limit },
      { client: this._client() },
    ) as Promise<ForgejoIssue[]>;
  }

  searchPullRequests(query: string, state: string = 'open', limit: number = 20): Promise<ForgejoPullRequest[]> {
    return issueSearchIssues(
      { q: query, state: state as 'open' | 'closed' | 'all', type: 'pulls', limit },
      { client: this._client() },
    ) as Promise<ForgejoPullRequest[]>;
  }

  listActionRuns(owner: string, repo: string, page: number = 1, limit: number = 30): Promise<ForgejoActionRunList> {
    this._assertActions();
    return listActionRuns(owner, repo, { page, limit }, { client: this._client() }) as Promise<ForgejoActionRunList>;
  }

  async getActionRun(owner: string, repo: string, runId: number): Promise<ActionRun> {
    this._assertActions();
    return actionRun(owner, repo, runId, { client: this._client() }) as Promise<ActionRun>;
  }

  async getActionRunJobs(owner: string, repo: string, runId: number): Promise<ForgejoActionRunJob[]> {
    this._assertActions();
    const result = await listActionRunJobs(owner, repo, runId, { client: this._client() });
    return (
      Array.isArray(result) ? result : ((result as { jobs?: ActionRunJob[] }).jobs ?? [])
    ) as ForgejoActionRunJob[];
  }

  async getActionRunArtifacts(owner: string, repo: string, runId: number): Promise<ForgejoActionArtifact[]> {
    this._assertActions();
    const artifacts = await this._fetchAllPages(
      async (page) => {
        const result = await listActionRunArtifacts(
          owner,
          repo,
          runId,
          { page, limit: PAGE_SIZE },
          { client: this._client() },
        );
        return Array.isArray(result) ? result : ((result as { artifacts?: ActionArtifact[] }).artifacts ?? []);
      },
      { label: 'action artifacts' },
    );
    return artifacts as ForgejoActionArtifact[];
  }

  async getActionJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    this._assertActions();
    const response = await repoGetActionJobLogs(owner, repo, jobId, undefined, {
      client: this._client(),
      responseType: 'text',
      signal: AbortSignal.timeout(API_DOWNLOAD_TIMEOUT_MS),
    });
    const text = (response as unknown as string) ?? '';
    // CI logs can be arbitrarily large; cap what is kept in memory and shown.
    if (text.length > MAX_JOB_LOG_LENGTH) {
      return `${text.slice(0, MAX_JOB_LOG_LENGTH)}\n... (truncated: log exceeds the 10 MB limit)`;
    }
    return text;
  }

  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflowfilename: string,
    ref: string,
    inputs?: Record<string, string>,
  ): Promise<DispatchWorkflowRun | undefined> {
    this._assertActions();
    const result = await dispatchWorkflow(
      owner,
      repo,
      encodePathSegment(workflowfilename),
      { ref, inputs, return_run_info: true },
      {
        client: this._client(),
      },
    );
    // Servers without return_run_info support answer 204 No Content, which
    // the base client surfaces as an empty object rather than undefined.
    if (!result || typeof result !== 'object' || Object.keys(result).length === 0) {
      return undefined;
    }
    return result as DispatchWorkflowRun;
  }

  async cancelActionRun(owner: string, repo: string, runId: number): Promise<void> {
    this._assertActions();
    await cancelActionRun(owner, repo, runId, { client: this._client() });
  }

  /**
   * Streams an artifact straight to disk instead of buffering it in the
   * extension host. The body is written to `<targetPath>.part` first and
   * renamed into place only after the download completed, so a failure never
   * leaves a half-written file at the target path (the partial file is
   * removed). Returns the number of bytes written. `maxBytes` is the
   * defensive size cap (2 GB by default); tests pass a small value.
   * There is deliberately no total timeout — large artifacts on slow links
   * take as long as they take; an idle watchdog aborts stalled downloads.
   */
  async downloadActionArtifactToFile(
    owner: string,
    repo: string,
    artifactId: number,
    targetPath: string,
    onProgress?: (bytesWritten: number) => void,
    maxBytes: number = MAX_ARTIFACT_BYTES,
  ): Promise<number> {
    this._assertActions();
    // No total cap: a 2 GB artifact on a slow link legitimately takes longer
    // than any fixed timeout. Instead an idle watchdog aborts the download
    // only when no bytes arrive for API_REQUEST_TIMEOUT_MS.
    const controller = new AbortController();
    let stalled = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleWatchdog = () => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      idleTimer = setTimeout(() => {
        stalled = true;
        controller.abort();
      }, API_REQUEST_TIMEOUT_MS);
    };
    resetIdleWatchdog();
    let stream: ReadableStream<Uint8Array> | null;
    try {
      stream = (await downloadActionArtifact(owner, repo, artifactId, {
        client: this._client(),
        responseType: 'stream',
        signal: controller.signal,
      })) as unknown as ReadableStream<Uint8Array> | null;
    } catch (error) {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (stalled) {
        throw new Error(`Forgejo artifact ${artifactId} download stalled: no data received for 30 seconds.`);
      }
      throw error;
    }
    if (!stream) {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      throw new Error(`Forgejo artifact ${artifactId} returned no response body.`);
    }

    const tempPath = `${targetPath}.part`;
    let written = 0;
    // Defensive cap against unbounded writes; enforced mid-stream so the
    // download aborts as soon as the limit is crossed.
    const counter = new Transform({
      transform(chunk: Uint8Array, _encoding, callback) {
        written += chunk.length;
        if (written > maxBytes) {
          callback(new Error(`Forgejo artifact ${artifactId} exceeds the 2 GB size limit and was not downloaded.`));
          return;
        }
        resetIdleWatchdog();
        onProgress?.(written);
        callback(null, chunk);
      },
    });

    try {
      await pipeline(
        Readable.fromWeb(stream as unknown as import('stream/web').ReadableStream<Uint8Array>),
        counter,
        fs.createWriteStream(tempPath),
      );
      await fs.promises.rename(tempPath, targetPath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => undefined);
      if (stalled) {
        throw new Error(`Forgejo artifact ${artifactId} download stalled: no data received for 30 seconds.`);
      }
      throw error;
    } finally {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
    }
    return written;
  }

  async deleteActionRun(owner: string, repo: string, runId: number): Promise<void> {
    this._assertActions();
    await deleteActionRun(owner, repo, runId, { client: this._client() });
  }

  /**
   * One page of notification threads. `before` is the page cursor (only
   * notifications updated before that instant), which keeps paging stable when
   * marking notifications read removes them from the filtered list.
   */
  async getNotifications(
    statusTypes: string[] = ['unread', 'pinned'],
    subjectType?: ('issue' | 'pull' | 'repository')[],
    limit: number = 50,
    before?: string,
  ): Promise<ForgejoNotification[]> {
    const notifications = await notifyGetList(
      {
        'status-types': statusTypes,
        ...(subjectType ? { 'subject-type': subjectType } : {}),
        limit,
        ...(before ? { before } : {}),
      },
      { client: this._client() },
    );
    return (notifications ?? []) as ForgejoNotification[];
  }

  async markNotificationRead(id: number): Promise<void> {
    await notifyReadThread(id, undefined, { client: this._client() });
  }

  async markAllNotificationsRead(): Promise<void> {
    await notifyReadList({ all: true, 'to-status': 'read' }, { client: this._client() });
  }

  /**
   * What the contents endpoint answered for `README.md`: its decoded text
   * (`content`), the honest sentence to show instead when the entry is not a
   * regular file (`notice`), the size of a regular file whose payload the
   * instance withheld (`size`), or `undefined` when the repository has no
   * README (a 404, or any other read failure — `_probe` treats them alike).
   *
   * The contents API omits the payload of a file above `[api]
   * DEFAULT_MAX_BLOB_SIZE` (10 MiB by default) and answers with the real
   * `size` instead of failing. `getReadme` can only report "no text" in that
   * case, which is indistinguishable from a repository without a README, so
   * this variant carries the size through: a caller that sees a size with no
   * content knows the payload was withheld and can say so (the host renders
   * the localized notice from its `utils/payloadNotice.ts`) instead of showing
   * a README-less repository.
   *
   * The `size` is only ever copied for a regular file. The endpoint answers a
   * symlinked README with `type: 'symlink'`, `target` and a `size` equal to the
   * *link target's* length — reading that as "the payload was withheld above
   * the instance's limit" named a cause the server never gave, next to a
   * nonsense size (0.0 MiB for a one-character target). A submodule README
   * (`type: 'submodule'`, size 0) has no payload at all. Both carry `notice`
   * instead, exactly like `getFileContentResult` answers those kinds.
   *
   * `getRepoDetail` calls this once and exposes the result as
   * `readme`/`readmeSize`, so a detail load needs no second probe.
   */
  async getReadmeEntry(
    owner: string,
    repo: string,
    ref?: string,
  ): Promise<{ content?: string; size?: number; notice?: string } | undefined> {
    const readmeFile = await this._probe(
      repoGetContents(owner, repo, README_PATH, ref ? { ref } : undefined, { client: this._client() }),
      `getReadmeEntry ${owner}/${repo}`,
    );
    if (!readmeFile || Array.isArray(readmeFile)) {
      return undefined;
    }
    const entry: { content?: string; size?: number; notice?: string } = {};
    // Content the server did send is always file content, whatever the entry
    // says, and the `size` alongside it is then the file's own size.
    if (readmeFile.content) {
      entry.content = decodeBase64(readmeFile.content);
    } else {
      switch ((readmeFile as { type?: string }).type) {
        case 'symlink':
          // `size` here is the *link target's* length, not a payload size.
          entry.notice = readmeSymlinkNotice((readmeFile as { target?: string }).target);
          return entry;
        case 'submodule':
          entry.notice = readmeSubmoduleNotice((readmeFile as { submodule_git_url?: string }).submodule_git_url);
          return entry;
        case 'dir':
          // Defensive: a directory answers with its listing (an array, handled
          // above), but a single `dir` entry must not fall through to the
          // size-based withheld-payload reading.
          return entry;
        default:
          break;
      }
    }
    // A regular file (or an entry that names no type at all, as older servers
    // do). A positive size with no content means the payload was withheld; size
    // 0 is a genuinely empty README.
    if (readmeFile.size !== undefined) {
      entry.size = readmeFile.size;
    }
    return entry;
  }

  async getReadme(owner: string, repo: string, ref?: string): Promise<string | undefined> {
    return (await this.getReadmeEntry(owner, repo, ref))?.content;
  }

  /**
   * Best-effort enrichment probe (permissions, attachments, README, previews):
   * a failure just means "no data", but it is logged at debug level so a
   * systematically failing endpoint stays diagnosable.
   */
  private async _probe<T>(promise: Promise<T>, what: string): Promise<T | undefined> {
    try {
      return await promise;
    } catch (error) {
      this.logger?.debug(
        `[probe] ${what}: ${redactErrorDetail(error instanceof Error ? error.message : String(error))}`,
      );
      return undefined;
    }
  }

  /**
   * Lightweight existence check for repo-path fallback binding (a remote host
   * that matches no configured instance URL may still be the same server
   * under another network address). Never throws: 404/network errors are
   * logged at debug level via _probe and reported as false.
   */
  async probeRepository(owner: string, repo: string): Promise<boolean> {
    const repository = await this._probe(
      repoGet(owner, repo, { client: this._client() }),
      `probeRepository ${owner}/${repo}`,
    );
    return repository !== undefined;
  }

  /**
   * Repository detail with its branch and commit lists capped at
   * `REPO_DETAIL_LIST_LIMIT`.
   *
   * Whether a list was cut is reported by `branchesTruncated` /
   * `recentCommitsTruncated` instead of being left to the caller's judgement:
   * the endpoint is asked for one row beyond the cap, so the extra row's
   * presence is proof of a cut, and the row itself is dropped before returning.
   * A caller comparing the returned length against the cap cannot tell a
   * repository with exactly `REPO_DETAIL_LIST_LIMIT` branches from one with
   * more, and reported the former as an incomplete list.
   */
  async getRepoDetail(owner: string, repo: string): Promise<ForgejoRepoDetailWithCaps> {
    const repository = await repoGet(owner, repo, { client: this._client() });
    const isEmpty = (repository as { empty?: boolean }).empty ?? false;

    if (isEmpty) {
      return {
        repository: repository as ForgejoRepository,
        empty: true,
        readme: undefined,
        branches: [],
        recentCommits: [],
      };
    }

    // One entry fetch answers both questions: the text to show and, when the
    // contents API withheld the payload, the size the notice needs. Probing a
    // second time from the caller is what made a README-less repository issue
    // `/contents/README.md` twice per detail load. The two list endpoints are
    // asked for `REPO_DETAIL_LIST_LIMIT + 1` rows so the cut can be observed.
    const [readmeEntry, branchPage, commitPage] = await Promise.all([
      this.getReadmeEntry(owner, repo),
      repoListBranches(owner, repo, { limit: REPO_DETAIL_LIST_LIMIT + 1 }, { client: this._client() }),
      repoGetAllCommits(owner, repo, { limit: REPO_DETAIL_LIST_LIMIT + 1 }, { client: this._client() }),
    ]);
    // Read off the raw page, not the filtered list: an entry the mapping below
    // drops (a branch with no name) must not hide the extra row that proves the
    // list was cut.
    const branchesTruncated = (branchPage?.length ?? 0) > REPO_DETAIL_LIST_LIMIT;
    const recentCommitsTruncated = (commitPage?.length ?? 0) > REPO_DETAIL_LIST_LIMIT;

    return {
      repository: repository as ForgejoRepository,
      empty: false,
      // Read the README's text when it arrived, and otherwise the honest
      // sentence for a README that is not a regular file (a symlink or a
      // submodule). Neither is a size, so `readmeSize` stays unset for them.
      readme: readmeEntry?.content ?? readmeEntry?.notice,
      // A positive size with no content and no notice is the only combination
      // that means "withheld": size 0 is a genuinely empty README, no entry at
      // all is an absent one, and a symlink/submodule has no payload to withhold
      // — all of those must leave this undefined.
      readmeSize:
        readmeEntry &&
        readmeEntry.content === undefined &&
        readmeEntry.notice === undefined &&
        readmeEntry.size &&
        readmeEntry.size > 0
          ? readmeEntry.size
          : undefined,
      branches: (branchPage ?? [])
        .map((branch) => branch.name ?? '')
        .filter(Boolean)
        .slice(0, REPO_DETAIL_LIST_LIMIT),
      branchesTruncated,
      recentCommits: (commitPage ?? []).slice(0, REPO_DETAIL_LIST_LIMIT).map(
        (commit) =>
          ({
            sha: commit.sha ?? '',
            commit: {
              message: commit.commit?.message ?? '',
              author: {
                name: commit.commit?.author?.name ?? '',
                date: commit.commit?.author?.date ?? '',
              },
            },
            author: commit.author as ForgejoUser | undefined,
            committer: commit.committer as ForgejoUser | undefined,
            html_url: commit.html_url ?? '',
          }) as ForgejoCommit,
      ),
      recentCommitsTruncated,
    };
  }

  /** Default branch of a repository, for tool calls that omit an explicit ref. */
  async getRepoDefaultBranch(owner: string, repo: string): Promise<string> {
    const repository = await repoGet(owner, repo, { client: this._client() });
    return (repository as ForgejoRepository).default_branch ?? 'main';
  }

  async getRepoBranchCommits(owner: string, repo: string, branch?: string): Promise<ForgejoCommit[]> {
    const commits = await repoGetAllCommits(owner, repo, branch ? { sha: branch, limit: 10 } : { limit: 10 }, {
      client: this._client(),
    });
    return (commits ?? []).map(
      (commit) =>
        ({
          sha: commit.sha ?? '',
          commit: {
            message: commit.commit?.message ?? '',
            author: {
              name: commit.commit?.author?.name ?? '',
              date: commit.commit?.author?.date ?? '',
            },
          },
          author: commit.author as ForgejoUser | undefined,
          committer: commit.committer as ForgejoUser | undefined,
          html_url: commit.html_url ?? '',
        }) as ForgejoCommit,
    );
  }

  /**
   * The commit history of one file, paged up to the shared list cap.
   *
   * A single `limit: 50` request presented the newest 50 commits as the whole
   * history: a busier file silently lost everything older, with no truncation
   * signal to notice it by. The endpoint takes `page`/`limit`, so the history is
   * read the same way every other capped list is; a result that still fills the
   * cap is detectable with `isListTruncated` (as the caller already does for the
   * other lists).
   */
  async getFileHistory(owner: string, repo: string, filepath: string, ref?: string): Promise<ForgejoCommit[]> {
    const commits = await this._fetchAllPages<Commit>(
      (page) =>
        repoGetAllCommits(
          owner,
          repo,
          ref ? { sha: ref, path: filepath, page, limit: PAGE_SIZE } : { path: filepath, page, limit: PAGE_SIZE },
          { client: this._client() },
        ) as Promise<Commit[] | null | undefined>,
      { label: 'file history' },
    );
    return commits.map(
      (commit) =>
        ({
          sha: commit.sha ?? '',
          commit: {
            message: commit.commit?.message ?? '',
            author: {
              name: commit.commit?.author?.name ?? '',
              date: commit.commit?.author?.date ?? '',
            },
          },
          author: commit.author as ForgejoUser | undefined,
          committer: commit.committer as ForgejoUser | undefined,
          html_url: commit.html_url ?? '',
          parents: commit.parents?.map((parent) => ({ sha: parent.sha })),
          files: commit.files?.map((file) => ({ filename: file.filename, status: file.status })),
        }) as ForgejoCommit,
    );
  }

  /**
   * One contents-API read, served from the shared short-lived memo when the same
   * file was already read a moment ago.
   *
   * The provider that opens repository files asks twice per open — `stat` for
   * the size and `readFile` for the blob — with a fresh client each time, so
   * without the memo the same blob is downloaded twice per file open. A caller
   * with an AbortSignal (an MCP tool call, via `withSignal`) never shares the
   * memo: its result belongs to that call, and the shared cache must not be
   * left holding a result the caller never received.
   */
  async getRepoContents(owner: string, repo: string, path: string, ref?: string): Promise<ForgejoContentEntry[]> {
    const params = ref ? { ref } : undefined;
    // The key carries the token hash for the same reason the tree cache does
    // (see `_getRepoTree`): two accounts on one origin see different bytes for
    // the same path, and this memo is shared across client instances.
    const cacheKey = this.abortSignal
      ? undefined
      : cacheKeyFor(this.configuredOrigin, this.tokenCacheKey, owner, repo, path, ref ?? '');
    if (cacheKey) {
      const cached = repoContentsCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.value;
      }
      if (cached) {
        repoContentsCache.delete(cacheKey);
        repoContentsCacheBytes -= cached.bytes;
      }
    }

    let entries: ForgejoContentEntry[];
    if (!path) {
      entries = ((await repoGetContentsList(owner, repo, params, { client: this._client() })) ??
        []) as ForgejoContentEntry[];
    } else {
      const result = await repoGetContents(owner, repo, encodeFilePath(path), params, { client: this._client() });
      entries = (Array.isArray(result) ? result : [result]) as ForgejoContentEntry[];
    }

    if (cacheKey) {
      // Bounded oldest-first by both entry count and total bytes: this is a
      // coalescing memo, not a store.
      rememberRepoContents(cacheKey, entries);
    }
    return entries;
  }

  /**
   * File paths in `owner/repo@ref` matching `query`, plus whether the response
   * may be incomplete: the git tree endpoint truncates large trees and paging
   * it has a bound, so a search over an incomplete tree can miss matches. The
   * caller shows that instead of implying the file does not exist.
   *
   * `truncatedBy` names which of the two causes applied, and only when the
   * result is truncated at all: `'matches'` when the match list hit
   * `MAX_SEARCH_RESULTS`, `'tree'` when the git tree could not be read
   * completely. An unreadable tree wins when both apply: a caller that hears
   * `'matches'` promises that a narrower query returns the rest, which cannot be
   * true when the matches were never all read. `files` is sliced to
   * `MAX_SEARCH_RESULTS` before it is returned, so a caller cannot recover the
   * cause from the list length: a complete tree with exactly that many matches
   * and a tree cut short by the cap are the same length.
   */
  async searchRepoFiles(
    owner: string,
    repo: string,
    ref: string,
    query: string,
  ): Promise<{ files: GitEntry[]; truncated: boolean; truncatedBy?: 'matches' | 'tree' }> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return { files: [], truncated: false };
    }

    const tree = await this._getRepoTree(owner, repo, ref);
    const allFiles = tree.entries.filter(
      (entry) => typeof entry.path === 'string' && entry.path.toLowerCase().includes(normalizedQuery),
    );

    const files = allFiles.sort((a, b) => {
      const pathA = a.path?.toLowerCase() ?? '';
      const pathB = b.path?.toLowerCase() ?? '';
      const nameA = pathA.split('/').pop() ?? '';
      const nameB = pathB.split('/').pop() ?? '';

      const scoreA = fileSearchScore(nameA, pathA, normalizedQuery);
      const scoreB = fileSearchScore(nameB, pathB, normalizedQuery);
      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }
      return pathA.localeCompare(pathB);
    });

    // More matches than the cap means the list was cut; a tree read that ended
    // truncated means matches may be missing. Reported by cause because only the
    // first can be improved by narrowing the query — and when both apply the
    // tree wins, since "a narrower query would return the rest" is a promise
    // this search cannot keep when the matches were never all read (the MCP note
    // follows the same principle for a missing signal).
    const matchesCapped = files.length > MAX_SEARCH_RESULTS;
    const truncated = tree.truncated || matchesCapped;
    return {
      files: files.slice(0, MAX_SEARCH_RESULTS),
      // Either the tree itself was incomplete or the match list was capped.
      truncated,
      // No cause to name when nothing was cut off: a `'tree'`/`'matches'` value
      // on a complete answer would describe a truncation that did not happen.
      truncatedBy: tree.truncated ? ('tree' as const) : matchesCapped ? ('matches' as const) : undefined,
    };
  }

  /**
   * Fetches the recursive git tree (blob entries only) for a ref, serving it
   * from the shared short-lived cache when possible. `truncated` reports that
   * the tree could not be read completely (the server truncates large trees and
   * the paging loop is bounded), so callers can say that results may be
   * incomplete instead of treating them as exhaustive.
   */
  private async _getRepoTree(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<{ entries: GitEntry[]; truncated: boolean }> {
    const key = cacheKeyFor(this.configuredOrigin, this.tokenCacheKey, owner, repo, ref);
    const cached = treeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { entries: cached.value, truncated: cached.truncated };
    }
    treeCache.delete(key);

    const allFiles: GitEntry[] = [];
    let truncated = false;
    let previousFirstSha: string | undefined;
    for (let page = 1; page <= MAX_TREE_PAGES; page++) {
      const response = await getTree(
        owner,
        repo,
        encodePathSegment(ref),
        { recursive: true, page, per_page: 100 },
        { client: this._client() },
      );
      const entries = response?.tree ?? [];
      const firstSha = entries[0]?.sha;
      if (entries.length === 0) {
        // Nothing at this page: the tree ends here, whatever the previous page
        // claimed about truncation.
        truncated = false;
        break;
      }
      // Guard against servers that ignore the pagination params and keep
      // returning the same page with truncated=true forever. Keep the flag of
      // the last real page: what was read is all the server will hand over.
      if (firstSha !== undefined && firstSha === previousFirstSha) {
        break;
      }
      previousFirstSha = firstSha;
      const files = entries.filter(
        (entry): entry is GitEntry => entry.type === 'blob' && typeof entry.path === 'string',
      );
      allFiles.push(...files);
      truncated = response?.truncated ?? false;
      if (!truncated) {
        break;
      }
    }

    // A truncated tree is cached too. Its paging loop is bounded, so the read is
    // as complete as this client will ever make it, and the server marks every
    // page but the last as truncated: not caching it meant a large repository
    // re-issued up to MAX_TREE_PAGES requests per search — for every query, since
    // the search itself is debounced but uncached. The entry carries the flag, so
    // a later caller still learns the result may be incomplete, and it expires on
    // the same TTL and is evicted oldest-first like any other. Failures are still
    // not cached: an error above propagates before this point.
    // Expired entries are counted out first: without that, up to
    // MAX_TREE_CACHE_ENTRIES trees whose TTL has passed stayed in the map (and
    // in memory) until a count-based eviction happened to pick them, and they
    // could evict a live entry to make room for a new one even though they
    // themselves were dead.
    const now = Date.now();
    purgeExpiredTreeCache(now);
    if (treeCache.size >= MAX_TREE_CACHE_ENTRIES) {
      // Map iteration order is insertion order: the first key is the oldest.
      const oldest = treeCache.keys().next().value;
      if (oldest !== undefined) {
        treeCache.delete(oldest);
      }
    }
    treeCache.set(key, { value: allFiles, truncated, expiresAt: now + TREE_CACHE_TTL_MS });
    return { entries: allFiles, truncated };
  }

  async getRepoBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    const branches = await this._fetchAllPages(
      (page) => repoListBranches(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'branches' },
    );
    return branches as ForgejoBranch[];
  }

  async getRepoTags(owner: string, repo: string): Promise<ForgejoTag[]> {
    const tags = await this._fetchAllPages(
      (page) => repoListTags(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'tags' },
    );
    return tags as ForgejoTag[];
  }

  async getRepoReleases(owner: string, repo: string): Promise<ForgejoRelease[]> {
    const releases = await this._fetchAllPages(
      (page) => repoListReleases(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'releases' },
    );
    return releases as ForgejoRelease[];
  }

  createBranch(owner: string, repo: string, data: CreateBranchRepoOption): Promise<ForgejoBranch> {
    return repoCreateBranch(owner, repo, data, { client: this._client() }) as Promise<ForgejoBranch>;
  }

  deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    return repoDeleteBranch(owner, repo, encodePathSegment(branch), { client: this._client() }) as Promise<void>;
  }

  createTag(owner: string, repo: string, data: CreateTagOption): Promise<ForgejoTag> {
    return repoCreateTag(owner, repo, data, { client: this._client() }) as Promise<ForgejoTag>;
  }

  deleteTag(owner: string, repo: string, tag: string): Promise<void> {
    return repoDeleteTag(owner, repo, encodePathSegment(tag), { client: this._client() }) as Promise<void>;
  }

  createRelease(owner: string, repo: string, data: CreateReleaseOption): Promise<ForgejoRelease> {
    return repoCreateRelease(owner, repo, data, { client: this._client() }) as Promise<ForgejoRelease>;
  }

  editRelease(owner: string, repo: string, id: number, data: EditReleaseOption): Promise<ForgejoRelease> {
    return repoEditRelease(owner, repo, id, data, { client: this._client() }) as Promise<ForgejoRelease>;
  }

  createReleaseAttachment(
    owner: string,
    repo: string,
    id: number,
    file: Uint8Array,
    filename: string,
  ): Promise<Attachment> {
    // Copy the bytes first: `file` may be a Uint8Array view over a larger
    // buffer, and `file.buffer` would upload the whole underlying buffer.
    const attachment = new File([file.slice().buffer as ArrayBuffer], filename);
    return repoCreateReleaseAttachment(
      owner,
      repo,
      id,
      { attachment },
      { name: filename },
      { client: this._client() },
    ).then((result) => {
      const data = result as Attachment;
      return {
        ...data,
        browser_download_url: data.browser_download_url ?? `${this.url}/attachments/${data.uuid}`,
      };
    });
  }

  deleteReleaseAttachment(owner: string, repo: string, id: number, attachmentId: number): Promise<void> {
    return repoDeleteReleaseAttachment(owner, repo, id, attachmentId, { client: this._client() }) as Promise<void>;
  }

  deleteRelease(owner: string, repo: string, id: number): Promise<void> {
    return repoDeleteRelease(owner, repo, id, { client: this._client() }) as Promise<void>;
  }

  async getIssueDetail(owner: string, repo: string, index: number): Promise<ForgejoIssueDetail> {
    const [issue, repoInfo] = await Promise.all([
      issueGetIssue(owner, repo, index, { client: this._client() }),
      this._probe(repoGet(owner, repo, { client: this._client() }), `getIssueDetail repo ${owner}/${repo}`),
    ]);
    const permissions = (repoInfo as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } } | undefined)
      ?.permissions;
    return {
      ...(issue as ForgejoIssueDetail),
      repoPermissions: permissions,
    };
  }

  async getPullRequestDetail(
    owner: string,
    repo: string,
    index: number,
  ): Promise<ForgejoPullRequestDetail & { attachmentsUnavailable?: boolean }> {
    // WORKAROUND: Forgejo's pulls endpoint does not return attachments.
    // The same underlying object is accessible via the issues endpoint,
    // which does include the `assets` field. See KNOWN_ISSUES.md.
    const [pr, issue, repoInfo] = await Promise.all([
      repoGetPullRequest(owner, repo, index, { client: this._client() }),
      this._probe(
        issueGetIssue(owner, repo, index, { client: this._client() }),
        `getPullRequestDetail issue #${index}`,
      ),
      this._probe(repoGet(owner, repo, { client: this._client() }), `getPullRequestDetail repo ${owner}/${repo}`),
    ]);
    const permissions = (repoInfo as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } } | undefined)
      ?.permissions;
    const prDetail = pr as ForgejoPullRequestDetail;
    const baseRef = prDetail.base?.ref;
    const headSha = prDetail.head?.sha;
    const combinedStatusPromise = headSha
      ? this._probe(
          repoGetCombinedStatusByRef(owner, repo, encodePathSegment(headSha), undefined, {
            client: this._client(),
          }),
          `combined status ${owner}/${repo}@${headSha}`,
        )
      : undefined;
    // Branch protection rules are repo-admin-only upstream, so asking as a
    // regular user only yields a 403 that must not be read as "this branch has
    // no rules". Ask only when the user administers the repository and report
    // the rules as unknown otherwise, so the view can say the merge status may
    // be incomplete instead of claiming the PR is ready.
    const protectionRead = await this._readBranchProtection(owner, repo, baseRef, permissions?.admin === true);
    const protection = protectionRead.protection;
    const combinedStatus = await combinedStatusPromise;
    // When the base branch requires approving reviews, count how many the PR
    // already has so the blocker clears once enough approvals are in.
    // Approximation: counts every official, non-stale, non-dismissed APPROVED
    // review without deduplicating reviewers.
    let approvedCount: number | undefined;
    if (
      protection?.required_approvals &&
      protection.required_approvals > 0 &&
      !(permissions?.admin === true && protection.apply_to_admins !== true)
    ) {
      const reviews = await this._probe(this.listPullReviews(owner, repo, index), `listPullReviews #${index}`);
      // A failed review-list probe leaves the count unknown, not at zero: the
      // `required_approvals` blocker it would otherwise fabricate disables Merge
      // for a PR that may well be approved.
      if (reviews !== undefined) {
        approvedCount = reviews.filter(
          (review) => review.state === 'APPROVED' && review.official === true && !review.stale && !review.dismissed,
        ).length;
      }
    }
    const mergeBlockers = this._buildMergeBlockers(
      prDetail,
      permissions,
      protection,
      protectionRead.unknown,
      combinedStatus,
      approvedCount,
    );
    const statusChecks = combinedStatus
      ? {
          state: combinedStatus.state,
          statuses: (combinedStatus.statuses ?? []).map((status) => ({
            id: status.id,
            context: status.context,
            description: status.description,
            status: status.status,
            target_url: status.target_url,
            created_at: status.created_at,
            updated_at: status.updated_at,
          })),
        }
      : undefined;
    return {
      ...prDetail,
      assets: (issue as ForgejoIssueDetail | undefined)?.assets,
      // The attachments come from the best-effort issues probe, so a failed
      // probe leaves `assets` undefined — which the view would render as "this
      // PR has no attachments", the false conclusion the per-comment flag also
      // exists to prevent. Reported only on failure: an absent flag is what a
      // caller that predates the field sees, and it stays the safe reading.
      ...(issue === undefined ? { attachmentsUnavailable: true } : {}),
      repoPermissions: permissions,
      protectionUnknown: protectionRead.unknown,
      mergeBlockers,
      statusChecks,
    };
  }

  /**
   * Branch protection rules for `branch`, read only when the user administers
   * the repository (the endpoint is admin-only upstream). `unknown` means the
   * rules could not be read, so the caller must not present the merge status as
   * complete; a 404 is a real answer ("this branch has no rules").
   */
  private async _readBranchProtection(
    owner: string,
    repo: string,
    branch: string | undefined,
    canRead: boolean,
  ): Promise<{
    protection?: {
      apply_to_admins?: boolean;
      required_approvals?: number;
      enable_status_check?: boolean;
      status_check_contexts?: string[];
    };
    unknown: boolean;
  }> {
    if (!canRead || !branch) {
      return { unknown: true };
    }
    try {
      const protection = (await repoGetBranchProtection(owner, repo, encodePathSegment(branch), {
        client: this._client(),
      })) as {
        apply_to_admins?: boolean;
        required_approvals?: number;
        enable_status_check?: boolean;
        status_check_contexts?: string[];
      };
      return { protection, unknown: false };
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.kind === 'http' && apiError.status === 404) {
        return { unknown: false };
      }
      this.logger?.debug(
        `[branchProtection] unreadable for ${owner}/${repo}@${branch}: ${redactErrorDetail(apiError.rawMessage)}`,
      );
      return { unknown: true };
    }
  }

  private _buildMergeBlockers(
    pr: ForgejoPullRequestDetail,
    permissions?: { admin?: boolean; push?: boolean; pull?: boolean },
    protection?: {
      apply_to_admins?: boolean;
      required_approvals?: number;
      enable_status_check?: boolean;
      status_check_contexts?: string[];
    },
    /** Whether the branch protection read failed or was never possible. */
    protectionUnknown = false,
    combinedStatus?: { state?: string },
    approvedCount?: number,
  ): MergeBlocker[] {
    const blockers: MergeBlocker[] = [];

    if (pr.draft) {
      blockers.push({ type: 'draft' });
    }
    if (pr.state !== 'open') {
      blockers.push({ type: 'closed' });
    }
    // Only a known permissions object can prove the user lacks push rights:
    // when the repo enrichment probe failed (timeout/5xx/offline) the
    // permissions are unknown, not denied. The webview disables merging for
    // any blocker, so reporting "no permission" here would tell the user they
    // may not merge because of a transient failure.
    if (permissions !== undefined && !permissions.admin && !permissions.push) {
      blockers.push({ type: 'no_permission' });
    } else if (permissions === undefined) {
      this.logger?.debug(`[mergeBlockers] permissions unknown for PR #${pr.number}; not blocking`);
    }

    const canBypassProtection = permissions?.admin === true && protection?.apply_to_admins !== true;
    // A required status check whose state could not be read is unknown, not
    // failed: `combinedStatus` comes from a best-effort probe and is undefined
    // on any failure (and when the PR carries no head sha). The webview disables
    // merging for every blocker and renders a missing state as `-`, so reporting
    // one here would tell the user their checks failed because of a transient
    // failure — the same reasoning that keeps an unknown permissions object from
    // becoming `no_permission` above. The flag also keeps the `conflicts`
    // fallback below from being fabricated: Forgejo reports `mergeable: false`
    // while checks are unresolved, so an unknown state must not be re-read as a
    // merge conflict either.
    let statusChecksUnknown = false;
    if (protection && !canBypassProtection) {
      const requiredApprovals = protection.required_approvals;
      if (requiredApprovals && requiredApprovals > 0) {
        // The approval count comes from a best-effort review-list probe, so an
        // unknown count must not be read as "zero approvals" — the same rule as
        // the permissions and status-check branches above.
        if (approvedCount === undefined) {
          this.logger?.debug(`[mergeBlockers] approval count unknown for PR #${pr.number}; not blocking`);
        } else if (approvedCount < requiredApprovals) {
          blockers.push({ type: 'required_approvals', requiredApprovals });
        }
      }
      if (protection.enable_status_check && (protection.status_check_contexts?.length ?? 0) > 0) {
        const state = combinedStatus?.state;
        if (state === undefined) {
          statusChecksUnknown = true;
          this.logger?.debug(`[mergeBlockers] required status checks unknown for PR #${pr.number}; not blocking`);
        } else if (state !== 'success') {
          blockers.push({ type: 'required_status_checks', statusState: state });
        }
      }
    }

    // `mergeable` is documented as a plain bool that is false when the server did
    // not compute it, and Forgejo also reports false while a protected branch's
    // required checks are still unresolved. So neither a failed status-check read
    // nor an unreadable branch protection may turn that false into a definite
    // "this pull request has conflicts": `_readBranchProtection` answers with no
    // rules for every non-admin and on a failed read, and reading its silence as
    // a conflict disables Merge for a PR whose real state is merely unknown —
    // exactly the reasoning that keeps an unknown permissions object out of
    // `no_permission` above. A 404 (a branch with no rules) is a real answer, so
    // it keeps reporting the conflict.
    const mergeStateUnknown = protectionUnknown || statusChecksUnknown;
    if (pr.mergeable === false && !mergeStateUnknown && !blockers.some((b) => b.type === 'required_status_checks')) {
      blockers.push({ type: 'conflicts' });
    } else if (pr.mergeable === false && mergeStateUnknown) {
      this.logger?.debug(
        `[mergeBlockers] mergeable=false with unknown branch state for PR #${pr.number}; not reporting conflicts`,
      );
    }

    return blockers;
  }

  async getRepoIssues(owner: string, repo: string, state: string = 'open', query?: string): Promise<ForgejoIssue[]> {
    const q = query?.trim();
    const issues = await this._fetchAllPages(
      (page) =>
        issueListIssues(
          owner,
          repo,
          { state: state as 'open' | 'closed' | 'all', type: 'issues', ...(q ? { q } : {}), page, limit: PAGE_SIZE },
          { client: this._client() },
        ),
      { label: 'issues' },
    );
    return issues as ForgejoIssue[];
  }

  async getRepoLabels(owner: string, repo: string): Promise<Label[]> {
    const labels = await this._fetchAllPages(
      (page) => issueListLabels(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'labels' },
    );
    return labels as Label[];
  }

  async getRepoAssignees(owner: string, repo: string): Promise<string[]> {
    const users = await repoGetAssignees(owner, repo, { client: this._client() });
    return ((users ?? []) as User[]).map((user) => user.login ?? '').filter(Boolean);
  }

  async getRepoMilestones(owner: string, repo: string): Promise<Milestone[]> {
    const milestones = await this._fetchAllPages(
      (page) =>
        issueGetMilestonesList(owner, repo, { state: 'open', page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'milestones' },
    );
    return milestones as Milestone[];
  }

  async searchMentions(
    owner: string,
    repo: string,
    query: string,
    type: 'user' | 'issue' | 'all',
  ): Promise<MentionSearchResult> {
    const searchUsers = type === 'user' || type === 'all';
    const searchIssues = type === 'issue' || type === 'all';

    const [userResults, issueResults] = await Promise.all([
      searchUsers
        ? userSearch({ q: query, limit: 10 }, { client: this._client() })
            .then((result) => (result?.data ?? []) as User[])
            .catch(() => [] as User[])
        : Promise.resolve([] as User[]),
      searchIssues
        ? issueListIssues(owner, repo, { state: 'all', q: query, limit: 10 }, { client: this._client() })
            .then((issues) => (issues ?? []) as ForgejoIssue[])
            .catch(() => [] as ForgejoIssue[])
        : Promise.resolve([] as ForgejoIssue[]),
    ]);

    return {
      users: userResults
        .map((user) => ({
          value: user.login ?? '',
          name: user.login ?? '',
          full_name: user.full_name || undefined,
          avatar_url: user.avatar_url || undefined,
        }))
        .filter((user) => user.value),
      issues: issueResults
        .map((issue) => ({
          value: String(issue.number ?? ''),
          title: issue.title ?? '',
          state: issue.state ?? '',
          user: issue.user,
          is_pull: !!issue.pull_request,
        }))
        .filter((issue) => issue.value),
    };
  }

  async getUserPreview(username: string): Promise<ForgejoUser | undefined> {
    const user = await this._probe(
      userGet(encodePathSegment(username), { client: this._client() }),
      `getUserPreview ${username}`,
    );
    return user as ForgejoUser | undefined;
  }

  async getIssuePreview(owner: string, repo: string, index: number): Promise<ForgejoIssue | undefined> {
    const issue = await this._probe(
      issueGetIssue(owner, repo, index, { client: this._client() }),
      `getIssuePreview #${index}`,
    );
    return issue as ForgejoIssue | undefined;
  }

  async getRepoPullRequests(
    owner: string,
    repo: string,
    state: string = 'open',
    query?: string,
  ): Promise<ForgejoPullRequest[]> {
    const q = query?.trim();
    if (q) {
      // repoListPullRequests has no keyword filter; the issues endpoint supports `q` with `type=pulls`.
      const pulls = await this._fetchAllPages(
        (page) =>
          issueListIssues(
            owner,
            repo,
            { state: state as 'open' | 'closed' | 'all', type: 'pulls', q, page, limit: PAGE_SIZE },
            { client: this._client() },
          ),
        { label: 'pull requests' },
      );
      // The issues endpoint returns issue-shaped rows (the old code cast them the
      // same way); drop any null entry first so consumers can dereference freely.
      return this._definedPullRequests(pulls) as ForgejoPullRequest[];
    }
    const pulls = await this._fetchAllPages(
      (page) =>
        repoListPullRequests(
          owner,
          repo,
          { state: state as 'open' | 'closed' | 'all', page, limit: PAGE_SIZE },
          {
            client: this._client(),
          },
        ),
      { label: 'pull requests' },
    );
    return this._definedPullRequests(pulls) as ForgejoPullRequest[];
  }

  /**
   * `repoListPullRequests` puts a `null` in the array when the server cannot
   * load a pull request's related rows (`convert.ToAPIPullRequest` returns nil
   * and the handler appends it as-is). Consumers dereference `pr.head` and
   * `pr.base` without checking the element itself, so drop those entries here
   * instead of letting one broken row crash the pull request list or the status
   * bar.
   */
  private _definedPullRequests<T>(pulls: (T | null | undefined)[]): T[] {
    return pulls.filter((pull): pull is T => pull !== null && pull !== undefined);
  }

  createIssue(owner: string, repo: string, data: CreateIssueOption): Promise<ForgejoIssue> {
    return issueCreateIssue(owner, repo, data, { client: this._client() }) as Promise<ForgejoIssue>;
  }

  editIssue(owner: string, repo: string, index: number, data: EditIssueOption): Promise<ForgejoIssue> {
    return issueEditIssue(owner, repo, index, data, { client: this._client() }) as Promise<ForgejoIssue>;
  }

  deleteIssue(owner: string, repo: string, index: number): Promise<unknown> {
    return issueDelete(owner, repo, index, { client: this._client() });
  }

  replaceIssueLabels(owner: string, repo: string, index: number, labels: number[]): Promise<Label[]> {
    return issueReplaceLabels(owner, repo, index, { labels }, { client: this._client() }) as Promise<Label[]>;
  }

  checkIssueSubscription(owner: string, repo: string, index: number): Promise<WatchInfo> {
    return issueCheckSubscription(owner, repo, index, { client: this._client() }) as Promise<WatchInfo>;
  }

  addIssueSubscription(owner: string, repo: string, index: number, user: string): Promise<unknown> {
    return issueAddSubscription(owner, repo, index, encodePathSegment(user), { client: this._client() });
  }

  deleteIssueSubscription(owner: string, repo: string, index: number, user: string): Promise<unknown> {
    return issueDeleteSubscription(owner, repo, index, encodePathSegment(user), { client: this._client() });
  }

  startIssueStopwatch(owner: string, repo: string, index: number): Promise<unknown> {
    return issueStartStopWatch(owner, repo, index, { client: this._client() });
  }

  stopIssueStopwatch(owner: string, repo: string, index: number): Promise<unknown> {
    return issueStopStopWatch(owner, repo, index, { client: this._client() });
  }

  deleteIssueStopwatch(owner: string, repo: string, index: number): Promise<unknown> {
    return issueDeleteStopWatch(owner, repo, index, { client: this._client() });
  }

  async listIssueTrackedTimes(owner: string, repo: string, index: number): Promise<TrackedTime[]> {
    const times = await this._fetchAllPages(
      (page) => issueTrackedTimes(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'tracked times' },
    );
    return times as TrackedTime[];
  }

  // The server answers 422 when time is missing or zero (the generated error type
  // only declares 400/403/404; regenerating from a pinned spec would add it).
  addIssueTime(owner: string, repo: string, index: number, time: number): Promise<TrackedTime> {
    const data: AddTimeOption = { time };
    return issueAddTime(owner, repo, index, data, { client: this._client() }) as Promise<TrackedTime>;
  }

  resetIssueTime(owner: string, repo: string, index: number): Promise<unknown> {
    return issueResetTime(owner, repo, index, { client: this._client() });
  }

  deleteIssueTime(owner: string, repo: string, index: number, id: number): Promise<unknown> {
    return issueDeleteTime(owner, repo, index, id, { client: this._client() });
  }

  async listIssueDependencies(owner: string, repo: string, index: number): Promise<ForgejoIssue[]> {
    // The endpoint pages like every other list (default 30, capped at
    // MaxResponseItems) and sends no total count, so an unpaged call silently
    // truncated issues with more than 30 dependencies. `_fetchAllPages` walks the
    // pages until one comes back short.
    return (await this._fetchAllPages(
      (page) => issueListIssueDependencies(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'issue dependencies' },
    )) as ForgejoIssue[];
  }

  createIssueDependency(owner: string, repo: string, index: number, dependencyIndex: number): Promise<unknown> {
    const data: IssueMeta = { index: dependencyIndex, owner, repo };
    return issueCreateIssueDependencies(owner, repo, index, data, { client: this._client() });
  }

  removeIssueDependency(owner: string, repo: string, index: number, dependencyIndex: number): Promise<unknown> {
    const data: IssueMeta = { index: dependencyIndex, owner, repo };
    return issueRemoveIssueDependencies(owner, repo, index, data, { client: this._client() });
  }

  async getIssueReactions(owner: string, repo: string, index: number): Promise<Reaction[]> {
    const reactions = await this._fetchAllPages(
      (page) => issueGetIssueReactions(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'issue reactions' },
    );
    return reactions as Reaction[];
  }

  addIssueReaction(owner: string, repo: string, index: number, content: string): Promise<Reaction> {
    return issuePostIssueReaction(owner, repo, index, { content }, { client: this._client() }) as Promise<Reaction>;
  }

  removeIssueReaction(owner: string, repo: string, index: number, content: string): Promise<unknown> {
    return issueDeleteIssueReaction(owner, repo, index, { content }, { client: this._client() });
  }

  getCommentReactions(owner: string, repo: string, commentId: number): Promise<Reaction[]> {
    return issueGetCommentReactions(owner, repo, commentId, { client: this._client() }) as Promise<Reaction[]>;
  }

  addCommentReaction(owner: string, repo: string, commentId: number, content: string): Promise<Reaction> {
    return issuePostCommentReaction(
      owner,
      repo,
      commentId,
      { content },
      { client: this._client() },
    ) as Promise<Reaction>;
  }

  removeCommentReaction(owner: string, repo: string, commentId: number, content: string): Promise<unknown> {
    return issueDeleteCommentReaction(owner, repo, commentId, { content }, { client: this._client() });
  }

  createIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    file: Uint8Array,
    filename: string,
  ): Promise<ForgejoIssueAttachment> {
    // Copy the bytes first: `file` may be a Uint8Array view over a larger
    // buffer, and `file.buffer` would upload the whole underlying buffer.
    const attachment = new File([file.slice().buffer as ArrayBuffer], filename);
    return issueCreateIssueAttachment(
      owner,
      repo,
      index,
      { attachment },
      { name: filename },
      { client: this._client() },
    ).then((result) => {
      const data = result as {
        id?: number;
        uuid?: string;
        name?: string;
        size?: number;
        browser_download_url?: string;
      };
      return {
        // The numeric id is what the delete endpoint takes; dropping it here left
        // the webview unable to delete an attachment it had just uploaded.
        id: data.id ?? 0,
        uuid: data.uuid ?? '',
        name: data.name ?? filename,
        size: data.size,
        browser_download_url: data.browser_download_url ?? `${this.url}/attachments/${data.uuid}`,
      };
    });
  }

  deleteIssueAttachment(owner: string, repo: string, index: number, attachmentId: number): Promise<void> {
    return issueDeleteIssueAttachment(owner, repo, index, attachmentId, { client: this._client() }) as Promise<void>;
  }

  createPullRequest(owner: string, repo: string, data: CreatePullRequestOption): Promise<ForgejoPullRequest> {
    return repoCreatePullRequest(owner, repo, data, { client: this._client() }) as Promise<ForgejoPullRequest>;
  }

  editPullRequest(
    owner: string,
    repo: string,
    index: number,
    data: EditPullRequestOption,
  ): Promise<ForgejoPullRequest> {
    return repoEditPullRequest(owner, repo, index, data, { client: this._client() }) as Promise<ForgejoPullRequest>;
  }

  /**
   * Reads one path through the contents endpoint and reports what is actually
   * there.
   *
   * Forgejo fills `content` only when the entry is a regular file. The other
   * three kinds it can answer with carry no payload, and each needs a different
   * answer than "here is the file":
   *
   * - `dir` answers with the directory's listing (an array), not an entry;
   * - `symlink` answers with `target`, the path the link points at, and a `size`
   *   equal to the *link target's* length — a size-only reading reported that as
   *   "the payload was withheld above the instance's limit", a cause the server
   *   never gave;
   * - `submodule` answers with `submodule_git_url` and `size` 0 — a size-only
   *   reading returned an empty string, which reads as "this file is empty".
   *
   * `kind` is what lets a caller act on the answer without parsing prose, and
   * `text` is either the decoded content (`file`; empty for a genuinely empty
   * file) or the honest sentence to answer with instead. Content the server did
   * send is always file content, whatever the entry says.
   */
  async getFileContentResult(owner: string, repo: string, filepath: string, ref?: string): Promise<FileContentResult> {
    const params = ref ? { ref } : undefined;
    const response = await repoGetContents(owner, repo, encodeFilePath(filepath), params, { client: this._client() });
    if (Array.isArray(response)) {
      return { kind: 'directory', text: directoryNotice(filepath) };
    }
    const entry = response as {
      type?: string;
      content?: string;
      size?: number;
      target?: string;
      submodule_git_url?: string;
    };
    if (entry.content) {
      return { kind: 'file', text: decodeBase64(entry.content) };
    }
    switch (entry.type) {
      case 'dir':
        // Defensive: the endpoint answers a directory with an array, but a
        // single `dir` entry must not fall through to the size-based branches.
        return { kind: 'directory', text: directoryNotice(filepath) };
      case 'symlink':
        return { kind: 'symlink', text: symlinkNotice(filepath, entry.target) };
      case 'submodule':
        return { kind: 'submodule', text: submoduleNotice(filepath, entry.submodule_git_url) };
      default:
        break;
    }
    // Forgejo withholds the payload of files above `[api] DEFAULT_MAX_BLOB_SIZE`
    // and reports the real size instead. A positive size with no content is the
    // only combination that means "withheld"; `type: 'file'` with size 0 is a
    // genuinely empty file, whose content is the empty string.
    if (entry.size && entry.size > 0) {
      return {
        kind: 'withheld',
        text: `Forgejo did not return this file's content: at ${entry.size} bytes it is above the instance's contents API payload limit. Read it in the browser instead.`,
      };
    }
    return { kind: 'file', text: '' };
  }

  /**
   * The decoded text of a file, or the sentence that stands in for it when the
   * path is not a regular file (see `getFileContentResult`). Callers that must
   * tell content from a notice use `getFileContentResult`; this convenience
   * keeps the string contract for callers that only display the answer.
   */
  async getFileContent(owner: string, repo: string, filepath: string, ref?: string): Promise<string> {
    return (await this.getFileContentResult(owner, repo, filepath, ref)).text;
  }

  async getPullRequestFiles(owner: string, repo: string, index: number): Promise<ForgejoChangedFile[]> {
    const files = await this._fetchAllPages(
      (page) => repoGetPullRequestFiles(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'pull request files' },
    );
    // The API spells a deleted file's status 'deleted' (the compare endpoint
    // uses 'removed'); consumers only recognize 'removed', so normalize here.
    return (files as ForgejoChangedFile[]).map((file) =>
      file.status === 'deleted' ? { ...file, status: 'removed' } : file,
    );
  }

  /**
   * Changed files for a commit range, derived from /compare. That endpoint
   * reports only the net added/removed/modified statuses (upstream builds them
   * from a CommitAffectedFiles list of {filename, status}) and carries no
   * linkage between the two halves of a rename: a rename arrives as an
   * unrelated removed+added pair. Inventing a mapping from that pair would
   * guess wrong whenever several files were removed/added in the range, so
   * `previous_filename` is never set here. Callers that need the old path of a
   * rename must use getPullRequestFiles (/pulls/{index}/files), which does
   * return it.
   */
  async getPullRequestFilesFromCompare(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<ForgejoChangedFile[]> {
    // The comparison is one path segment (`compare/{base}..{head}`), and the URL
    // parser resolves dot segments, so both refs are encoded per segment: a
    // forged `../` value cannot walk the request onto another endpoint. Anything
    // that is exactly `.`/`..` is refused by `encodePathSegment`.
    const compare = await repoCompareDiff(owner, repo, `${encodePathSegment(baseSha)}..${encodePathSegment(headSha)}`, {
      client: this._client(),
    });
    const statusMap = new Map<string, string>();
    const compareFiles = (compare.files ?? []) as Array<{ filename?: string; status?: string }>;
    for (const file of compareFiles) {
      const filename = file.filename ?? '';
      if (!filename) {
        continue;
      }
      const existing = statusMap.get(filename);
      const status = file.status ?? 'changed';
      if (existing) {
        const merged = mergeCompareStatuses(existing, status);
        if (merged === undefined) {
          statusMap.delete(filename);
        } else {
          statusMap.set(filename, merged);
        }
      } else {
        statusMap.set(filename, status);
      }
    }
    return Array.from(statusMap.entries()).map(([filename, status]) => ({
      filename,
      status,
      additions: 0,
      deletions: 0,
      changes: 0,
    }));
  }

  async getPullRequestCommentsAndTimeline(owner: string, repo: string, index: number): Promise<TimelineComment[]> {
    const comments = await this._fetchAllPages<TimelineComment>(
      (page) =>
        issueGetCommentsAndTimeline(
          owner,
          repo,
          index,
          { page, limit: PAGE_SIZE },
          { client: this._client() },
        ) as Promise<TimelineComment[] | null | undefined>,
      // The timeline drops some rows (code comments, unreadable cross-repository
      // references) *after* the page has been read from the database, so a page
      // that comes back shorter than the page size does not mean the timeline
      // ended — keep paging until an empty page arrives.
      { label: 'timeline', shortPageMarksEnd: false },
    );
    // Body-reference heuristic: only comments whose body links an attachment
    // (see ATTACHMENT_REFERENCE_REGEX) get an attachment-list request, instead
    // of one API call per comment. Note the behavior change: attachments that
    // were uploaded but later unlinked from the body are no longer listed.
    const commentIds = comments
      .filter((c) => c.id !== undefined && ATTACHMENT_REFERENCE_REGEX.test(c.body ?? ''))
      .map((c) => c.id as number);
    const assetsMap = new Map<number, ForgejoIssueAttachment[]>();
    const unavailable = new Set<number>();
    // Bounded fan-out: a comment list can reach the list cap (500 rows), and a
    // self-hosted instance must not receive hundreds of simultaneous GETs. The
    // same 4-in-flight shape the webview uses keeps the batch fast without
    // flooding the server.
    await mapWithConcurrency(commentIds, 4, async (commentId) => {
      try {
        const assets = (await issueListIssueCommentAttachments(owner, repo, commentId, {
          client: this._client(),
        })) as {
          id?: number;
          uuid?: string;
          name?: string;
          size?: number;
          browser_download_url?: string;
        }[];
        assetsMap.set(
          commentId,
          assets.map((a) => ({
            id: a.id,
            uuid: a.uuid ?? '',
            name: a.name ?? '',
            size: a.size,
            browser_download_url: a.browser_download_url ?? `${this.url}/attachments/${a.uuid}`,
          })),
        );
      } catch (error) {
        // A failed lookup must stay distinguishable from "this comment has no
        // attachments": rendering the failure as an empty list told the user
        // their attachment was gone. The flag lets the view say the list could
        // not be loaded instead.
        this.logger?.debug(
          `[probe] comment assets for #${commentId}: ${redactErrorDetail(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
        unavailable.add(commentId);
        assetsMap.set(commentId, []);
      }
    });
    return comments.map((c) => {
      if (c.id === undefined) {
        return c;
      }
      return {
        ...c,
        assets: assetsMap.get(c.id) ?? [],
        ...(unavailable.has(c.id) ? { attachmentsUnavailable: true } : {}),
      };
    });
  }

  createIssueComment(owner: string, repo: string, index: number, body: string): Promise<TimelineComment> {
    return issueCreateComment(owner, repo, index, { body }, { client: this._client() }) as Promise<TimelineComment>;
  }

  editIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<TimelineComment> {
    return issueEditComment(owner, repo, commentId, { body }, { client: this._client() }) as Promise<TimelineComment>;
  }

  deleteIssueComment(owner: string, repo: string, commentId: number): Promise<void> {
    return issueDeleteComment(owner, repo, commentId, { client: this._client() }) as Promise<void>;
  }

  deleteIssueCommentAttachment(owner: string, repo: string, commentId: number, attachmentId: number): Promise<void> {
    return issueDeleteIssueCommentAttachment(owner, repo, commentId, attachmentId, {
      client: this._client(),
    }) as Promise<void>;
  }

  createIssueCommentAttachment(
    owner: string,
    repo: string,
    commentId: number,
    file: Uint8Array,
    filename: string,
  ): Promise<ForgejoIssueAttachment> {
    // Copy the bytes first: `file` may be a Uint8Array view over a larger
    // buffer, and `file.buffer` would upload the whole underlying buffer.
    const attachment = new File([file.slice().buffer as ArrayBuffer], filename);
    return issueCreateIssueCommentAttachment(
      owner,
      repo,
      commentId,
      { attachment },
      { name: filename },
      { client: this._client() },
    ).then((result) => {
      const data = result as {
        id?: number;
        uuid?: string;
        name?: string;
        size?: number;
        browser_download_url?: string;
      };
      return {
        id: data.id,
        uuid: data.uuid ?? '',
        name: data.name ?? filename,
        size: data.size,
        browser_download_url: data.browser_download_url ?? `${this.url}/attachments/${data.uuid}`,
      };
    });
  }

  async getPullRequestCommits(owner: string, repo: string, index: number): Promise<Commit[]> {
    const commits = await this._fetchAllPages(
      (page) =>
        repoGetPullRequestCommits(
          owner,
          repo,
          index,
          { files: true, page, limit: PAGE_SIZE },
          { client: this._client() },
        ),
      { label: 'pull request commits' },
    );
    return commits as Commit[];
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    index: number,
    strategy: 'merge' | 'rebase' | 'squash',
  ): Promise<void> {
    await repoMergePullRequest(owner, repo, index, { Do: strategy }, { client: this._client() });
    // The merge moved the base branch, so every cached tree and file body for
    // this instance is now potentially pre-merge: the tree cache has no way to
    // know which ref changed, and serving a cached commit list or file from
    // before the merge is exactly the staleness the user sees right after
    // merging. Drop the whole shared memo instead of trying to guess.
    invalidateRepoContentCaches();
  }

  async getPullRequestDiff(owner: string, repo: string, index: number): Promise<string> {
    const response = await repoDownloadPullDiffOrPatch(owner, repo, index, 'diff', undefined, {
      client: this._client(),
      responseType: 'text',
      signal: AbortSignal.timeout(API_DOWNLOAD_TIMEOUT_MS),
    });
    return (response as unknown as string) ?? '';
  }

  async listPullReviews(owner: string, repo: string, index: number): Promise<PullReview[]> {
    const result = await this._fetchAllPages(
      (page) => repoListPullReviews(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
      { label: 'pull request reviews' },
    );
    return result as PullReview[];
  }

  async getPullReviewComments(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
  ): Promise<PullReviewComment[]> {
    const result = await repoGetPullReviewComments(owner, repo, index, reviewId, { client: this._client() });
    return (result ?? []) as PullReviewComment[];
  }

  async createPullReviewWithComment(
    owner: string,
    repo: string,
    index: number,
    comment: CreatePullReviewComment,
  ): Promise<PullReview> {
    // For event=COMMENT with comments, Forgejo does not require a review-level body.
    // Leaving it empty avoids duplicating the comment text as a timeline entry.
    return repoCreatePullReview(
      owner,
      repo,
      index,
      {
        event: 'COMMENT',
        comments: [comment],
      },
      { client: this._client() },
    ) as Promise<PullReview>;
  }

  async createPendingPullReview(
    owner: string,
    repo: string,
    index: number,
    comment: CreatePullReviewComment,
  ): Promise<PullReview> {
    // Pending reviews require a non-empty body even when comments are attached.
    // Use a placeholder; it will be replaced when the review is submitted.
    return repoCreatePullReview(
      owner,
      repo,
      index,
      {
        event: 'PENDING',
        body: '.',
        comments: [comment],
      },
      { client: this._client() },
    ) as Promise<PullReview>;
  }

  async addPullReviewComment(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    comment: CreatePullReviewComment,
  ): Promise<PullReviewComment> {
    return repoCreatePullReviewComment(owner, repo, index, reviewId, comment, {
      client: this._client(),
    }) as Promise<PullReviewComment>;
  }

  async submitPullReview(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    event: string = 'COMMENT',
    body?: string,
  ): Promise<PullReview> {
    return repoSubmitPullReview(
      owner,
      repo,
      index,
      reviewId,
      { event, body: body ?? '' },
      { client: this._client() },
    ) as Promise<PullReview>;
  }

  async deletePullReview(owner: string, repo: string, index: number, reviewId: number): Promise<void> {
    await repoDeletePullReview(owner, repo, index, reviewId, { client: this._client() });
  }

  async deletePullReviewComment(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    commentId: number,
  ): Promise<void> {
    await repoDeletePullReviewComment(owner, repo, index, reviewId, commentId, { client: this._client() });
  }

  async renderMarkdown(text: string, context?: string): Promise<string> {
    // Routed through _client() like every other call: debug logging, error
    // body truncation, and syncApiUrlsToInstanceUrl URL rewriting all apply.
    const result = await apiRenderMarkdown(
      { Text: text, Mode: 'gfm', Context: context },
      { client: this._client(), responseType: 'text', headers: { Accept: 'text/html' } },
    );
    return (result as unknown as string) ?? '';
  }

  private _rewriteResponseData<T>(data: T): T {
    if (!this.syncApiUrlsToInstanceUrl) {
      return data;
    }

    // Per response shape, not per client instance: the view provider builds a
    // ForgejoClient for every message, so an instance field alone never spares
    // the next request the scan. The fingerprint below only samples the first
    // few items of each array, so it stays cheap on a 500-item list.
    const shape = `${this.configuredOrigin}|${_shapeFingerprint(data)}`;
    if (noRewriteShapes.has(shape)) {
      return data;
    }

    const detected = this._serverOriginFor(data);
    if (!detected) {
      // The payload names no server origin at all: nothing can be rewritten.
      rememberShape(shape);
      return data;
    }

    if (!this._hasUrlOnOrigin(data, detected)) {
      // Nothing in the payload points at the detected origin, so the rewrite
      // would change no value. Returning the payload as it arrived skips the
      // deep copy that used to be paid on every response — 85-150 ms for a
      // 500-item list.
      rememberShape(shape);
      return data;
    }

    this.detectedServerOrigin = detected;
    return this._rewriteUrls(data, detected, this.configuredOrigin);
  }

  /**
   * The server origin a payload's API-provided URLs point at, or undefined when
   * it holds none.
   *
   * Detection walks the payload, so its result is memoized per configured origin
   * in `detectedOriginByConfigured`; that memo, not the `detectedServerOrigin`
   * instance field, is what survives the per-message client rebuild.
   */
  private _serverOriginFor(data: unknown): string | undefined {
    const memoized = detectedOriginByConfigured.get(this.configuredOrigin);
    if (memoized !== undefined) {
      return memoized;
    }
    const detected = this._detectServerOrigin(data);
    if (!detected) {
      return undefined;
    }
    detectedOriginByConfigured.set(this.configuredOrigin, detected);
    this.detectedServerOrigin = detected;
    return detected;
  }

  /** True when any string value is a URL on `origin` (the same keys detection skips). */
  private _hasUrlOnOrigin(data: unknown, origin: string): boolean {
    const visit = (value: unknown, key?: string): boolean => {
      if (typeof value === 'string') {
        if (key === 'avatar_url' || key === 'website' || key === 'original_url') {
          return false;
        }
        const parsed = this._parseUrl(value);
        return parsed !== undefined && parsed.origin === origin;
      }
      if (Array.isArray(value)) {
        return value.some((item) => visit(item));
      }
      if (value && typeof value === 'object') {
        return Object.entries(value).some(([childKey, item]) => visit(item, childKey));
      }
      return false;
    };

    return visit(data);
  }

  private _detectServerOrigin(data: unknown): string | undefined {
    const counts = new Map<string, number>();

    const visit = (value: unknown, key?: string) => {
      if (typeof value === 'string') {
        // Fields whose URLs legitimately point away from the server must not
        // participate in the count, or an external host gets "detected" as the
        // server origin and those links are then rewritten into broken
        // instance URLs: avatar_url (every embedded user carries one, e.g.
        // gravatar), website (user/repo homepages), original_url (mirror
        // source of a mirrored repository).
        if (key === 'avatar_url' || key === 'website' || key === 'original_url') {
          return;
        }
        const parsed = this._parseUrl(value);
        if (parsed && parsed.origin !== this.configuredOrigin) {
          counts.set(parsed.origin, (counts.get(parsed.origin) ?? 0) + 1);
        }
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value && typeof value === 'object') {
        for (const [childKey, item] of Object.entries(value)) visit(item, childKey);
      }
    };

    visit(data);

    let bestOrigin: string | undefined;
    let bestCount = 0;
    for (const [origin, count] of counts) {
      if (count > bestCount) {
        bestCount = count;
        bestOrigin = origin;
      }
    }
    return bestOrigin;
  }

  private _rewriteUrls<T>(data: T, fromOrigin: string, toOrigin: string): T {
    if (typeof data === 'string') {
      const parsed = this._parseUrl(data);
      if (parsed && parsed.origin === fromOrigin) {
        return data.replace(fromOrigin, toOrigin) as T;
      }
      return data;
    }
    if (Array.isArray(data)) {
      return data.map((item) => this._rewriteUrls(item, fromOrigin, toOrigin)) as T;
    }
    if (data && typeof data === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this._rewriteUrls(value, fromOrigin, toOrigin);
      }
      return result as T;
    }
    return data;
  }

  private _parseUrl(value: string): URL | undefined {
    try {
      return new URL(value);
    } catch {
      return undefined;
    }
  }

  /**
   * The same client, with an abort signal attached to every request it makes.
   *
   * The MCP SDK hands each tool call an AbortSignal; building a per-call client
   * (rather than mutating a shared one) keeps concurrent tool calls independent.
   */
  withSignal(signal?: AbortSignal): ForgejoClient {
    return new ForgejoClient(this.url, this.token, this.logger, this.syncApiUrlsToInstanceUrl, {
      signal,
      // Keep this client's own proxy pair: a signalling copy must not silently
      // fall back to the activation-wide one (or to a direct connection).
      dispatcher: this.requestDispatcher,
      fetch: this.requestFetch,
    });
  }

  private _client(): Client {
    const baseURL = `${this.url.replace(/\/$/, '')}/api/v1`;
    return async <TResponseData, _TError = unknown, TRequestData = unknown>(
      config: RequestConfig<TRequestData>,
    ): Promise<ResponseConfig<TResponseData>> => {
      const method = config.method ?? 'GET';
      // Serialize via the same helper the base client uses, so the logged URL
      // matches the actual request (array params repeat the key).
      const targetUrl = buildUrl({ ...config, baseURL });
      // A configured instance URL may embed the access token
      // (`https://user:token@host`), and buildUrl carries that userinfo into
      // every request URL. These lines reach the output channel and the MCP
      // server's stderr, so the userinfo is blanked before logging. The request
      // itself is unaffected: the token travels in the Authorization header.
      const logUrl = redactUrlUserinfo(targetUrl);
      const debugEnabled = this.logger?.isDebugEnabled() ?? false;
      const start = debugEnabled ? Date.now() : 0;
      this.logger?.debug(`Request: ${method} ${logUrl}`);

      try {
        const dispatcher = this.requestDispatcher ?? defaultRequestDispatcher;
        // A client-local dispatcher must be paired with its own fetch; only the
        // activation-wide pair is safe to reuse for the default one.
        const requestFetch = this.requestDispatcher ? this.requestFetch : defaultRequestFetch;
        const response = await baseClient<TResponseData>({
          // A cancelled MCP tool call aborts its requests, and a configured proxy is
          // a Node fetch dispatcher plus the undici fetch that understands it.
          ...withDispatcher(
            withAbortSignal(config, requestSignalFor(config.signal, this.abortSignal)),
            dispatcher,
            requestFetch,
          ),
          baseURL,
          headers: mergeHeaders(config.headers, { Authorization: `token ${this.token}` }),
        });

        if (debugEnabled) {
          const duration = Date.now() - start;
          this.logger?.debug(`Response: ${response.status} ${response.statusText} (${duration}ms)`);
          if (config.responseType === 'text' || config.responseType === 'arraybuffer') {
            // Raw payloads (CI logs, diffs, artifacts) can be huge and may
            // contain secrets in plain text; log metadata only.
            this.logger?.debug(`Response body: <${config.responseType}> (not logged)`);
          } else {
            this.logger?.debug(`Response body: ${JSON.stringify(response.data).slice(0, 2000)}`);
          }
        }

        return {
          ...response,
          // Streams are passed through untouched: rewriting walks JSON-shaped
          // payloads and would mangle a ReadableStream into an empty object.
          data: config.responseType === 'stream' ? response.data : this._rewriteResponseData(response.data),
        };
      } catch (error) {
        if (debugEnabled) {
          const duration = Date.now() - start;
          this.logger?.debug(`Request failed after ${duration}ms: ${method} ${logUrl}`);
        }
        if (error instanceof Error) {
          this._notifyIfPermissionError(error.message);
        }
        // Normalize into a structured ApiError: message stays raw for logs and
        // pattern matching, userMessage carries the localized rendering. The
        // request URL supplies the resource kind and scope a 404 message names,
        // and an installed dispatcher tells the classifier that a connection
        // failure happened on the way through the proxy.
        //
        // The proxy signal has to come from the dispatcher the request actually
        // used, not from this client's own field: the extension installs the
        // configured proxy once through `setDefaultRequestDispatcher`, so every
        // ordinary client (`this.requestDispatcher === undefined`) runs proxied
        // while the per-client field stays unset. Reading the field alone left
        // the whole sidebar, onboarding panel and review-comment panel reporting
        // "Cannot connect to the instance. Check that it is running" for a proxy
        // that refused the connection — the wrong host to look at.
        const viaProxy = this.requestDispatcher !== undefined || defaultRequestDispatcher !== undefined;
        throw toApiError(error, requestContextFor(targetUrl, { viaProxy }));
      }
    };
  }

  /**
   * Routes auth failures (401, scope-related 403) to the registered host:
   * the extension shows fix-guidance toasts, headless consumers ignore them.
   */
  private _notifyIfPermissionError(errorMessage: string) {
    const match = errorMessage.match(/Forgejo API error (\d+):\s*([\s\S]+)/);
    if (!match) {
      return;
    }
    const [, status, body] = match;
    const text = body.trim();
    const host = getForgejoClientHost();

    if (status === '401') {
      host.notifyInvalidCredentials(this.url);
      return;
    }

    if (status !== '403' || !/required scope|token does not have/i.test(text)) {
      return;
    }
    // Forgejo names the missing scope in the error body ("token does not have
    // at least one of required scope(s): [write:issue]").
    const scopeMatch = text.match(/required scope\(s\): \[([^\]]+)\]/i);
    host.notifyInsufficientScope(this.url, { scope: scopeMatch?.[1], body: text });
  }
}

/**
 * Remove credentials from every URL inside an error message bound for the log.
 *
 * `toApiError` keeps the underlying failure text verbatim, and a failure that
 * never reached the server quotes the request URL back — `fetch` refuses to
 * build a request from a URL that carries credentials and names the whole URL
 * in the `TypeError` it throws. A configured instance URL may embed the access
 * token (`https://user:token@host`), and an imported config stores one without
 * a connection test, so the debug lines that print a caught error pass it
 * through the same `redactUrlUserinfo` rule as `_client()`'s request lines. The
 * cause and the request path survive; only the userinfo is replaced. Not
 * exported: callers outside this module log through the client's own logger.
 */
function redactErrorDetail(detail: string): string {
  return detail.replace(/https?:\/\/[^\s"'`<>()[\]]+/gi, (url) => redactUrlUserinfo(url));
}

/**
 * Run `task` for every item with at most `limit` tasks in flight, preserving no
 * particular order. Used for per-comment follow-up requests: the item list can
 * reach the list cap, and firing them all at once floods a self-hosted instance.
 */
async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let index = next++; index < items.length; index = next++) {
      await task(items[index]);
    }
  });
  await Promise.all(workers);
}

function mergeHeaders(...headers: Array<RequestConfig['headers'] | undefined>): Record<string, string> {
  return headers.reduce<Record<string, string>>((merged, h) => {
    if (!h) {
      return merged;
    }
    const entries = Array.isArray(h) ? h : Object.entries(h);
    for (const [key, value] of entries) {
      if (value !== undefined) {
        merged[key] = String(value);
      }
    }
    return merged;
  }, {});
}

function decodeBase64(content: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(content, 'base64').toString('utf-8');
  }
  return atob(content);
}

/**
 * The entry kinds the contents endpoint can answer with. `file` is the only one
 * that carries content; `withheld` is a regular file whose payload the instance
 * did not send, and `directory`/`symlink`/`submodule` are entries that never
 * have a payload at all (see `ForgejoClient.getFileContentResult`).
 */
export type FileContentKind = 'file' | 'withheld' | 'directory' | 'symlink' | 'submodule';

/**
 * What `getFileContentResult` found at a path. `text` is the decoded content for
 * `kind: 'file'` — the empty string for a genuinely empty file — and the
 * sentence to answer with instead of content for every other kind.
 */
export interface FileContentResult {
  kind: FileContentKind;
  text: string;
}

/**
 * The path `getReadmeEntry` probes. Named once so the notice sentences below
 * name the same file the request did.
 */
const README_PATH = 'README.md';

/** The answer for a path that names a directory, whose response is its listing. */
function directoryNotice(path: string): string {
  return `${path} is a directory, not a file: use list_repo_contents to list its entries.`;
}

/**
 * The answer for a symlink. The target is the API's `target` field; when a
 * server omits it the sentence still says what the entry is rather than
 * inventing a target (the `size` field is the *target's* length, not content).
 */
function symlinkNotice(path: string, target?: string): string {
  return target
    ? `${path} is a symlink, not a file: it points to ${target}. Request that path instead, or open the symlink in the Forgejo web UI.`
    : `${path} is a symlink, not a file: it points elsewhere in the repository. Open it in the Forgejo web UI, or request the path it points to.`;
}

/**
 * The answer for a submodule, whose own repository is named by the API's
 * `submodule_git_url` field. Its `size` is 0, so the withheld-payload reading
 * never applies and the old fallback returned an empty string.
 */
function submoduleNotice(path: string, gitUrl?: string): string {
  return gitUrl
    ? `${path} is a submodule, not a file: its own repository is at ${gitUrl}. Open the submodule in the Forgejo web UI, or clone that repository.`
    : `${path} is a submodule, not a file: it is a separate repository, so it has no file content here. Open it in the Forgejo web UI.`;
}

/**
 * The answer for a README that is a symlink. The contents API fills `content`
 * only for a regular file and answers a symlink with `target` and a `size` equal
 * to the link target's length, so that size is not the README's and must never
 * become a withheld-payload notice. Kept separate from `symlinkNotice` because
 * the caller here is the dashboard's README preview, not a file read: it says
 * where the text lives rather than asking for a different path.
 */
function readmeSymlinkNotice(target?: string): string {
  return target
    ? `${README_PATH} is a symlink to ${target}, so Forgejo returned no text for it. Open ${target} in the Forgejo web UI to read it.`
    : `${README_PATH} is a symlink that points elsewhere in the repository, so Forgejo returned no text for it. Open it in the Forgejo web UI to read it.`;
}

/**
 * The answer for a README that is a submodule: the entry names its own
 * repository and carries no payload at all (its size is 0), so there is no text
 * this repository can show and none was withheld.
 */
function readmeSubmoduleNotice(gitUrl?: string): string {
  return gitUrl
    ? `${README_PATH} is a submodule whose own repository is at ${gitUrl}, so this repository holds no README text for it. Open the submodule in the Forgejo web UI to read it there.`
    : `${README_PATH} is a submodule, a separate repository, so this repository holds no README text for it. Open it in the Forgejo web UI.`;
}

// The generated API clients interpolate path parameters into the URL without
// any encoding (they build the path via plain template literals), so values
// coming from repository data — branch names, tags, refs, file paths — would
// corrupt the request path when they contain `/`, `#` or `?`. Encoding at the
// call layer is safe from double encoding because the generated code never
// encodes itself.
//
// Single-segment params (branch/tag/ref) use encodePathSegment, i.e. full
// encodeURIComponent. Verified against the Forgejo source: a global
// middleware forces chi to route on the escaped path (RawPath) and
// ctx.Params unescapes afterwards, so `%2F` survives matching even on
// non-wildcard single-segment routes like git/trees/{sha} —
// `feature%2Ffoo` resolves correctly (routers/common/middleware.go,
// services/context/base.go in the Forgejo tree). The only case that
// still 404s is a reverse proxy in front of Forgejo that decodes %2F
// before forwarding; that is a deployment issue the client cannot fix.
//
// File paths keep their `/` separators because the contents API route
// wildcard-matches the remainder of the path, so each segment is encoded
// separately.
function encodeFilePath(path: string): string {
  return path.split('/').map(encodePathSegment).join('/');
}

function fileSearchScore(name: string, path: string, query: string): number {
  if (name === query) {
    return 100;
  }
  if (name.startsWith(query)) {
    return 80;
  }
  if (name.includes(query)) {
    return 60;
  }
  const basenameWords = name.split(/[-_.\s]+/);
  if (basenameWords.some((word) => word.startsWith(query))) {
    return 40;
  }
  if (path.includes(query)) {
    return 20;
  }
  return 0;
}
