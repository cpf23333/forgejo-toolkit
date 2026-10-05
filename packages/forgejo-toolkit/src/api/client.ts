import * as fs from 'fs';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { encodePathSegment, RequestError } from '@cpf23333-forgejo-toolkit/shared/request';
import { LIST_ITEM_LIMIT, MAX_REPO_FILE_SEARCH_RESULTS } from '@cpf23333-forgejo-toolkit/shared/limits';
import { toApiError, requestContextFor } from './errors-core';
import { getForgejoClientHost } from './clientHost';
import type { TranslateFn } from './translate';
import { assertActionsSupportedAfterProbe, setServerVersion } from './serverVersion';
import { withSharedServerVersion } from './serverVersionCache';
import { redactUrlUserinfo } from '../utils/redactUrlUserinfo';
import type { RequestConfig, RequestFetch } from '@cpf23333-forgejo-toolkit/shared/request';
import type { ClientInstance } from '@cpf23333-forgejo-toolkit/api/kubb';
import { createClientCore } from '@cpf23333-forgejo-toolkit/api/kubb';
import { defaultPathSerializer } from '@cpf23333-forgejo-toolkit/api/kubb/serializers';
import { rememberResponseType, sharedRequestTransport } from './sharedTransport';
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
  issueGetIssue,
  issueGetIssueReactions,
  issueListIssueCommentAttachments,
  issueListIssueDependencies,
  issueListIssues,
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
  repoGetActionJobLogs,
  dispatchWorkflow,
  cancelActionRun,
  downloadActionArtifact,
  deleteActionRun,
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
  repoGetPullReviewComments,
  repoListBranches,
  repoMergePullRequest,
  repoSearch,
  repoSubmitPullReview,
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
  ForgejoCompareCommit,
  ForgejoContentEntry,
  ForgejoIssue,
  ForgejoIssueAttachment,
  ForgejoIssueDetail,
  MergeBlocker,
  ForgejoNotification,
  ForgejoPullRequest,
  ForgejoPullRequestDetail,
  ForgejoRelease,
  ForgejoReadmeNotice,
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
// Exported for the MCP `get_ci_failure_summary` tool: that cap keeps the head
// of a log, so the tool has to tell the agent when the "tail" it extracted is
// only the end of what this cap left, not the end of the real log.
export const MAX_JOB_LOG_LENGTH = 10 * 1024 * 1024;
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
// the TTL would never pay off. Entries are keyed by instance URL (origin AND
// sub-path, so two deployments sharing a host never alias) + token hash +
// repo + ref, so same-host accounts never share cached trees. Bounded with
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
 * full normalized URL (origin + sub-path), and the response shapes already
 * proven to need no rewriting.
 *
 * Both are module-level for the same reason as `treeCache`: the view provider
 * constructs a ForgejoClient per message, so per-instance state dies with each
 * request and the scan/copy would run again on every response. The detection
 * memo is keyed by the configured instance URL rather than the bare origin
 * because a reverse proxy can route two sub-paths of one host (`/a`, `/b`) to
 * different backends whose payloads point at different internal origins; an
 * origin-keyed verdict would hand the first backend's answer to the second.
 * Both memos are small — one entry per configured instance, one per response
 * shape — and the shape memo is capped at `MAX_ORIGIN_MEMO_ENTRIES`.
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
 * A cheap structural fingerprint of a JSON response: property names, array
 * lengths, and — for strings — whether the value *is* an http(s) URL, sampling
 * at most `SHAPE_SAMPLE_ITEMS` items and `SHAPE_MAX_DEPTH` levels.
 *
 * Sampling — rather than hashing every value — is what makes it cheaper than
 * the scan it replaces on a 500-item list. The URL-ness of each string slot
 * must be part of the fingerprint because the no-rewrite verdict is recorded
 * only for payloads that hold no URL value at all: two responses can share
 * every key and array length and still differ in which strings hold URLs (an
 * `html_url` left empty in one response and filled in the next), and a
 * structure-only fingerprint let the memo skip the rewrite the second response
 * needed.
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
  if (typeof value === 'string') {
    return isHttpUrlValue(value) ? 'url' : 'string';
  }
  return typeof value;
}

/**
 * Whether a string value is itself an http(s) URL — the only values
 * `_rewriteUrls` can change. A prose field that merely *mentions* a URL does
 * not parse as one and stays plain text for the fingerprint.
 */
function isHttpUrlValue(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
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
 * A list read together with the server's own item total, when the endpoint
 * reported one. Forgejo's list endpoints send the full count in the
 * `X-Total-Count` response header; older (or proxied) servers omit it, and
 * `totalCount` is then `undefined`, which callers must read as "unknown" —
 * the length-based truncation heuristic (`isListTruncatedWithTotal`) is the
 * fallback, never "complete".
 */
export interface PagedList<T> {
  items: T[];
  totalCount?: number;
}

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
 * The installed proxy dispatcher pair, read per request.
 *
 * The direct model transport (`src/ai/openAiCompatibleTransport.ts`) sends to an
 * address the user configured rather than to a Forgejo instance, so it cannot go
 * through `ForgejoClient` — but it must still honour the same proxy, and it must
 * be the *same* pair the rest of the extension uses rather than a second HTTP
 * client with its own proxy handling. Returning the pair as a value (instead of
 * exporting the two module-level variables) keeps the "read it when the request
 * runs, not when the caller is built" rule visible: activation installs the pair,
 * and a caller constructed before that still sees it.
 */
export function defaultRequestDispatcherPair(): { dispatcher?: unknown; fetchImpl?: RequestFetch } {
  return { dispatcher: defaultRequestDispatcher, fetchImpl: defaultRequestFetch };
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

/**
 * Adds an abort signal to a request config. Exported so the merge can be asserted
 * directly: a mocked HTTP layer rebuilds the Request and drops the caller signal,
 * which hides this from an end-to-end test.
 */
export function withAbortSignal<TRequestData>(
  config: RequestConfig<TRequestData>,
  signal?: AbortSignal,
): RequestConfig<TRequestData> {
  return signal ? { ...config, signal } : config;
}

/**
 * What `getReadmeEntry` found at `README.md`: the decoded text (`content`), the
 * honest sentence to show instead when the entry is not a regular file
 * (`notice`), the size of a regular file whose payload the instance withheld
 * (`size`), or `undefined` when the repository has no README (a 404, or any
 * other read failure — `_probe` treats them alike).
 *
 * `noticeKind`/`noticeTarget` are the structured form of `notice`: what the
 * entry is, and the link target or git URL the API named for it. They let a
 * localized caller (the extension host's dashboard) build its own sentence
 * instead of showing the English one, while `notice` itself stays for the
 * headless MCP consumers that have no translator.
 */
export interface ReadmeEntry {
  content?: string;
  size?: number;
  notice?: string;
  noticeKind?: ForgejoReadmeNotice['kind'];
  noticeTarget?: string;
}

/**
 * Narrowing options for `ForgejoClient.getRepoPullRequests`, for a caller that
 * only needs to know whether one branch has a pull request (the create-PR
 * status bar) instead of the whole list.
 */
export interface RepoPullRequestOptions {
  /**
   * Sent as the endpoint's `head` filter, which Forgejo compares to
   * `pull_request.head_branch` exactly (`repoListPullRequests` in the pinned
   * swagger; the parameter arrived in Forgejo v16 and its backports). It is what
   * turns the common case into one request instead of one per page of the whole
   * list — but it is a narrowing, not the answer: the filter has no owner part
   * (`owner:branch` is not a form it accepts) and a fork's pull request shares
   * the branch name, so the caller's own head-repository check still decides the
   * match. Instances older than the filter ignore the parameter and answer the
   * unfiltered list, which the paging reads exactly as it did before.
   *
   * Ignored on the keyword-search path: that request goes to the issues
   * endpoint, which has no branch filter.
   */
  head?: string;
  /**
   * Stop reading pages once a row satisfies this. The pages read up to that
   * point are returned like any other read, so a caller can still inspect what
   * arrived; a caller that only asked a lookup question pays for the page that
   * answers it instead of for the whole list up to the shared item cap.
   * `totalCount` keeps describing the whole list, not the pages read.
   */
  stopWhen?: (pull: ForgejoPullRequest) => boolean;
}

export class ForgejoClient {
  private readonly configuredOrigin: string;
  /**
   * The configured instance URL normalized for cache keys: origin plus
   * sub-path, no trailing slash, no userinfo. The bare origin is not enough —
   * two deployments can share a host under different sub-paths (`/a` vs `/b`)
   * and, when they use the same token, an origin-keyed cache would let one
   * deployment's client read the other's trees and file bodies.
   */
  private readonly configuredInstanceUrl: string;
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
  /**
   * The version probe this client has in flight, if any. Cached so a burst of
   * gated calls (the Actions views, a workflow dispatch plus its refresh) shares
   * one request instead of each waiting on its own; cleared when it settles, so
   * a later stale-version gate can probe again.
   */
  private versionProbe: Promise<string | undefined> | undefined;
  /**
   * When the request currently in flight started, for the debug response line.
   * Only read while debug logging is on, so a single field is enough: the
   * generated layer runs one `_client()` per call and a `ForgejoClient` is built
   * per message, so concurrent requests on one instance are a burst of the same
   * read rather than a sequence a caller distinguishes.
   */
  private _requestStartedAt: number | undefined;
  /**
   * The Kubb client every generated operation in this file sends through. Built
   * once, in the constructor: the base URL, credential and abort signal are fixed
   * for a `ForgejoClient`'s lifetime (`withSignal` builds a new one instead of
   * mutating a shared client), while the proxy pair is resolved per request by
   * the transport — see `_client()`.
   */
  private readonly client: ClientInstance;

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
    const configured = new URL(this.url.replace(/\/+$/, ''));
    this.configuredOrigin = configured.origin;
    // Userinfo is deliberately absent from the key: the token hash below
    // already separates accounts, and credentials have no business in cache
    // keys. The trailing slash is stripped so two spellings of one deployment
    // share their entries.
    this.configuredInstanceUrl = `${configured.origin}${configured.pathname}`.replace(/\/+$/, '');
    this.syncApiUrlsToInstanceUrl = syncApiUrlsToInstanceUrl ?? true;
    this.tokenCacheKey = createHash('sha256').update(token).digest('hex').slice(0, 16);
    this.client = this._client();
  }

  getCurrentUser(): Promise<ForgejoUser> {
    return userGetCurrent({ client: this.client }) as Promise<ForgejoUser>;
  }

  /** Raw `/api/v1/version` string (e.g. "1.21.5"), undefined when the server omits it. */
  async getServerVersion(): Promise<string | undefined> {
    const result = await getVersion({ client: this.client });
    return (result as { version?: string }).version;
  }

  /**
   * The Actions API only exists on Forgejo/Gitea ≥ 1.19; older instances
   * answer a bare 404. Gate on the probed server version (fail-open when
   * unknown) so users get an actionable message instead.
   *
   * On demand, not on a timer: the shared probe cache's TTL turns an old record
   * into "unknown", and "unknown" passes — so a long session would otherwise
   * lose this gate. The first gated call after the record goes stale therefore
   * renews it, through the shared single-flight coordination, before the gate is
   * evaluated. That costs one request per stale window and nothing at all while
   * the record is fresh.
   */
  private async _assertActions(): Promise<void> {
    await assertActionsSupportedAfterProbe(
      this.url,
      () => this._probeAndRecordServerVersion(),
      getForgejoClientHost().t,
    );
  }

  /**
   * The probe behind {@link _assertActions}, deduplicated in two layers.
   *
   * In this process: several gated calls can start in the same turn (a dashboard
   * read fanning out over Actions endpoints), so the promise is cached on the
   * client and shared rather than each call carrying its own request.
   *
   * Across windows: the fetch runs inside the shared single-flight coordination
   * (`withSharedServerVersion`), so a window that sees another window's live
   * marker waits for that window's entry instead of issuing its own request.
   * `getVersion` is called directly — not `client.getServerVersion()` — because
   * the latter is the raw endpoint the gate wraps; calling it back here could
   * only recurse.
   */
  private async _probeAndRecordServerVersion(): Promise<string | undefined> {
    const inFlight = this.versionProbe;
    if (inFlight !== undefined) {
      return inFlight;
    }
    const probe = (async () => {
      try {
        const outcome = await withSharedServerVersion(this.url, async () => {
          const result = await getVersion({ client: this.client });
          return (result as { version?: string }).version;
        });
        const version = outcome?.version;
        // The shared cache already holds it. Record it here as well so a host
        // whose store is unusable (or whose merged write was lost) does not
        // re-probe on the next gated call.
        if (version) {
          setServerVersion(this.url, version);
        }
        return version;
      } finally {
        this.versionProbe = undefined;
      }
    })();
    this.versionProbe = probe;
    return probe;
  }

  /**
   * One page of a list endpoint, read through the shared request client
   * directly so the response headers survive. The generated wrappers return
   * only `res.data` and drop `X-Total-Count` — the header Forgejo's list
   * endpoints use to report the full item count — and they cannot be edited
   * (generated code, no regeneration environment), so the list endpoints that
   * need the total call this with a path literal that duplicates the wrapper's
   * URL construction (its path builder is module-private). Once the wrappers
   * are regenerated to expose headers, these calls should move back to them.
   *
   * A missing or non-numeric header means "total unknown" (`undefined`), which
   * every consumer must treat exactly like the old length-based heuristic. A
   * non-array body — the shared client answers a 204/205/304 or an empty 200
   * with `{}` rather than an array — is an empty page, the same reading
   * `_fetchAllPagesMeta` gives a bare-array fetcher's non-array answer.
   *
   * `extract` is for the endpoints whose page is not the body itself: the
   * Actions artifacts listing answers `{ artifacts: [...] }`. It maps the body
   * to the rows and must return `undefined` (or an empty array) for a body that
   * carries none, which is then the same empty page as above.
   */
  private async _getListPage<T>(
    path: string,
    params?: Record<string, unknown>,
    extract?: (data: unknown) => T[] | undefined,
  ): Promise<PagedList<T>> {
    // The path is already built (see `_repoPath`) and the query is serialized
    // here, so it travels as `params` rather than through the generated path
    // template. `throwOnError: false` is what keeps the response headers
    // reachable: a generated operation with `throwOnError` on resolves to the
    // success body alone, while off it resolves to the whole result — the
    // `X-Total-Count` header this caller exists for lives on `response`.
    const res = await this.client({ method: 'GET', url: path, params, throwOnError: false });
    if (res.error !== undefined) {
      // `throwOnError: false` bought the headers at the cost of the throw the
      // caller had before. Restore it rather than reading `data` off a failure:
      // a 404 read as an empty page would report "this list is empty" for a list
      // the server refused to answer, and `_fetchAllPagesMeta` would stop paging
      // on that page instead of failing.
      throw res.error;
    }
    const rawTotal = res.response.headers.get('x-total-count');
    const parsedTotal = rawTotal === null ? NaN : Number(rawTotal);
    const data = res.data;
    const items = extract ? extract(data) : Array.isArray(data) ? (data as T[]) : [];
    return {
      items: items ?? [],
      totalCount: Number.isFinite(parsedTotal) ? parsedTotal : undefined,
    };
  }

  /**
   * `/repos/{owner}/{repo}` plus `suffix`, with both path segments encoded:
   * `_getListPage` hands this string to the client core as a finished path, so it
   * carries no `{param}` placeholder for the path serializer to fill in and the
   * encoding the generated wrappers would have done has to happen here. Used by
   * the list endpoints read through `_getListPage` to keep their
   * `X-Total-Count`.
   */
  private _repoPath(owner: string, repo: string, suffix = ''): string {
    return `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}${suffix}`;
  }

  /**
   * Fetches every page of a list endpoint. The server may silently clamp the
   * requested limit (MAX_RESPONSE_ITEMS), so the first page's length — not
   * PAGE_SIZE — defines the effective page size: only a shorter later page
   * (or an empty one) means the list is exhausted. The safety bound caps the
   * total item count (not the page count), so a clamped page size does not
   * shrink the overall result window.
   *
   * The page fetcher may answer with a bare array (a generated wrapper, which
   * dropped the response headers) or with a `_getListPage` result; the total
   * is taken from the first page that reports one, and later pages are
   * trusted to agree with it rather than re-read. The total does not stop the
   * loop early: a stale or filtered count must never cut a list short, so
   * paging still ends on a short/empty page or the safety bound.
   *
   * `stopWhen` is the one thing that does stop the loop early, and only when
   * the caller asks for it: a caller with a lookup question ("is the branch in
   * here?") gets its answer from the page that carries the row and does not pay
   * for the rest. The rows read so far are returned as usual, and the total
   * still describes the whole list, so such a caller has to read a truncated
   * result as "I stopped", not as "the server cut it".
   *
   * `label` names the list in the completion log: `API_REQUEST_TIMEOUT_MS`
   * bounds one request, not the whole paged operation, so the request count is
   * the only visible measure of what a multi-page read cost the caller (and
   * how close it came to the item cap).
   */
  private async _fetchAllPagesMeta<T>(
    fetchPage: (page: number) => Promise<PagedList<T> | T[] | null | undefined>,
    options: { label: string; shortPageMarksEnd?: boolean; stopWhen?: (item: T) => boolean },
  ): Promise<PagedList<T>> {
    const shortPageMarksEnd = options.shortPageMarksEnd ?? true;
    const stopWhen = options.stopWhen;
    // Endpoints that filter rows *after* the page was read from the database can
    // return an empty page while later pages still hold rows (a whole page of
    // code comments is dropped, for instance). Those callers pass
    // `shortPageMarksEnd: false` and tolerate one such gap: paging stops only
    // after this many consecutive empty pages, which keeps the look-ahead
    // bounded (one extra request in the normal case).
    const maxConsecutiveEmptyPages = shortPageMarksEnd ? 1 : 2;
    const all: T[] = [];
    let totalCount: number | undefined;
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
      const fetched = await fetchPage(page);
      // The shared request client answers a 204/205/304 (or an empty 200 body)
      // with `{}` rather than an array, and `?? []` does not catch that:
      // spreading a non-array below would throw. Treat any non-array answer as
      // an empty page, which the empty-page rule below already handles.
      const items = Array.isArray(fetched) ? fetched : Array.isArray(fetched?.items) ? fetched.items : [];
      if (page === 1 && !Array.isArray(fetched) && typeof fetched?.totalCount === 'number') {
        totalCount = fetched.totalCount;
      }
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
      // The caller's own answer arrived with this page; later pages would only
      // cost requests. Checked after the duplicate guard above, so a server that
      // repeats a page cannot make a stop predicate fire on stale rows, and only
      // defined rows reach the predicate: the pull request list can carry a null
      // row (`_definedPullRequests`), and every caller's matcher dereferences the
      // row exactly like the consumers of the returned list do.
      if (stopWhen && items.some((item) => item != null && stopWhen(item))) {
        break;
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
    return { items: all, totalCount };
  }

  /**
   * `_fetchAllPagesMeta` for callers that only want the rows. Keeps the
   * historical signature so every list endpoint whose total nobody consumes
   * yet (labels, milestones, timeline, …) behaves exactly as before.
   */
  private async _fetchAllPages<T>(
    fetchPage: (page: number) => Promise<PagedList<T> | T[] | null | undefined>,
    options: { label: string; shortPageMarksEnd?: boolean },
  ): Promise<T[]> {
    return (await this._fetchAllPagesMeta(fetchPage, options)).items;
  }

  async getUserStopWatches(): Promise<StopWatch[]> {
    const watches = await this._fetchAllPages(
      (page) => userGetStopWatches({ query: { page, limit: PAGE_SIZE }, client: this.client }),
      { label: 'stop watches' },
    );
    return watches as StopWatch[];
  }

  async getUserRepositories(): Promise<PagedList<ForgejoRepository>> {
    return this._fetchAllPagesMeta(
      (page) => this._getListPage<ForgejoRepository>('/user/repos', { page, limit: PAGE_SIZE }),
      { label: 'repositories' },
    );
  }

  createUserRepo(data: CreateRepoOption): Promise<Repository> {
    return createCurrentUserRepo({ body: data, client: this.client });
  }

  async getUserIssues(state: string = 'open', query?: string): Promise<ForgejoIssue[]> {
    const issues = await this._fetchAllPages(
      (page) =>
        issueSearchIssues({
          query: {
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
          client: this.client,
        }),
      { label: 'user issues' },
    );
    return issues as ForgejoIssue[];
  }

  async getUserPullRequests(state: string = 'open', query?: string): Promise<ForgejoPullRequest[]> {
    const pulls = await this._fetchAllPages(
      (page) =>
        issueSearchIssues({
          query: {
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
          client: this.client,
        }),
      { label: 'user pull requests' },
    );
    return pulls as ForgejoPullRequest[];
  }

  searchRepositories(query: string, limit: number = 20): Promise<ForgejoRepository[]> {
    return repoSearch({ query: { q: query, limit }, client: this.client }).then(
      (result) => (result?.data ?? []) as ForgejoRepository[],
    );
  }

  searchIssues(query: string, state: string = 'open', limit: number = 20): Promise<ForgejoIssue[]> {
    return issueSearchIssues({
      query: { q: query, state: state as 'open' | 'closed' | 'all', type: 'issues', limit },
      client: this.client,
    }) as Promise<ForgejoIssue[]>;
  }

  searchPullRequests(query: string, state: string = 'open', limit: number = 20): Promise<ForgejoPullRequest[]> {
    return issueSearchIssues({
      query: { q: query, state: state as 'open' | 'closed' | 'all', type: 'pulls', limit },
      client: this.client,
    }) as Promise<ForgejoPullRequest[]>;
  }

  async listActionRuns(
    owner: string,
    repo: string,
    page: number = 1,
    limit: number = 30,
  ): Promise<ForgejoActionRunList> {
    await this._assertActions();
    return listActionRuns({
      path: { owner, repo },
      query: { page, limit },
      client: this.client,
    }) as Promise<ForgejoActionRunList>;
  }

  async getActionRun(owner: string, repo: string, runId: number): Promise<ActionRun> {
    await this._assertActions();
    return actionRun({ path: { owner, repo, run_id: runId }, client: this.client }) as Promise<ActionRun>;
  }

  async getActionRunJobs(owner: string, repo: string, runId: number): Promise<ForgejoActionRunJob[]> {
    await this._assertActions();
    const result = await listActionRunJobs({ path: { owner, repo, run_id: runId }, client: this.client });
    return (
      Array.isArray(result) ? result : ((result as { jobs?: ActionRunJob[] }).jobs ?? [])
    ) as ForgejoActionRunJob[];
  }

  /**
   * The artifacts of a run together with the server's own artifact count (see
   * `PagedList`). The listing endpoint answers `{ artifacts: [...] }` rather
   * than a bare array, hence the extractor: the total arrives in
   * `X-Total-Count` either way, and without it a run holding exactly
   * `LIST_ITEM_LIMIT` artifacts read as "possibly truncated".
   */
  async getActionRunArtifactsWithTotal(
    owner: string,
    repo: string,
    runId: number,
  ): Promise<PagedList<ForgejoActionArtifact>> {
    await this._assertActions();
    const result = await this._fetchAllPagesMeta<ActionArtifact>(
      (page) =>
        this._getListPage<ActionArtifact>(
          this._repoPath(owner, repo, `/actions/runs/${runId}/artifacts`),
          { page, limit: PAGE_SIZE },
          (data) =>
            Array.isArray(data)
              ? (data as ActionArtifact[])
              : ((data as { artifacts?: ActionArtifact[] })?.artifacts ?? []),
        ),
      { label: 'action artifacts' },
    );
    return { items: result.items as ForgejoActionArtifact[], totalCount: result.totalCount };
  }

  /**
   * The rows of `getActionRunArtifactsWithTotal`, for the callers that only want
   * the artifacts (the extension's run view).
   */
  async getActionRunArtifacts(owner: string, repo: string, runId: number): Promise<ForgejoActionArtifact[]> {
    return (await this.getActionRunArtifactsWithTotal(owner, repo, runId)).items;
  }

  async getActionJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    await this._assertActions();
    const response = await repoGetActionJobLogs({
      path: { owner, repo, job_id: jobId },
      client: this.client,
      responseType: 'text',
      signal: AbortSignal.timeout(API_DOWNLOAD_TIMEOUT_MS),
    });
    const text = (response as unknown as string) ?? '';
    // CI logs can be arbitrarily large; cap what is kept in memory and shown.
    // The suffix reaches the webview's log view, so it goes through the host's
    // translate seam (English passthrough for the headless MCP host) and names
    // the actual cap instead of a hardcoded number that can drift from
    // MAX_JOB_LOG_LENGTH.
    if (text.length > MAX_JOB_LOG_LENGTH) {
      const limitMb = MAX_JOB_LOG_LENGTH / (1024 * 1024);
      return `${text.slice(0, MAX_JOB_LOG_LENGTH)}\n${getForgejoClientHost().t('... (truncated: log exceeds the {0} MB limit)', limitMb)}`;
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
    await this._assertActions();
    const result = await dispatchWorkflow({
      path: { owner, repo, workflowfilename },
      body: { ref, inputs, return_run_info: true },
      client: this.client,
    });
    // Servers without return_run_info support answer 204 No Content, which
    // the base client surfaces as an empty object rather than undefined.
    if (!result || typeof result !== 'object' || Object.keys(result).length === 0) {
      return undefined;
    }
    return result as DispatchWorkflowRun;
  }

  async cancelActionRun(owner: string, repo: string, runId: number): Promise<void> {
    await this._assertActions();
    await cancelActionRun({ path: { owner, repo, run_id: runId }, client: this.client });
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
    await this._assertActions();
    // No total cap: a 2 GB artifact on a slow link legitimately takes longer
    // than any fixed timeout. Instead an idle watchdog aborts the download
    // only when no bytes arrive for API_REQUEST_TIMEOUT_MS.
    const t = getForgejoClientHost().t;
    // The error for a watchdog abort, needed on both sides of the stream
    // setup; the idle window is interpolated so the message cannot drift from
    // API_REQUEST_TIMEOUT_MS.
    const stalledError = () =>
      new Error(
        t(
          'Forgejo artifact {0} download stalled: no data received for {1} seconds.',
          artifactId,
          API_REQUEST_TIMEOUT_MS / 1000,
        ),
      );
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
      stream = (await downloadActionArtifact({
        path: { owner, repo, artifact_id: artifactId },
        client: this.client,
        responseType: 'stream',
        signal: controller.signal,
      })) as unknown as ReadableStream<Uint8Array> | null;
    } catch (error) {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      if (stalled) {
        throw stalledError();
      }
      throw error;
    }
    if (!stream) {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer);
      }
      throw new Error(t('Forgejo artifact {0} returned no response body.', artifactId));
    }

    const tempPath = `${targetPath}.part`;
    let written = 0;
    // Defensive cap against unbounded writes; enforced mid-stream so the
    // download aborts as soon as the limit is crossed. The message interpolates
    // the cap actually in force — tests pass a small `maxBytes`.
    const counter = new Transform({
      transform(chunk: Uint8Array, _encoding, callback) {
        written += chunk.length;
        if (written > maxBytes) {
          callback(
            new Error(
              t(
                'Forgejo artifact {0} exceeds the {1} size limit and was not downloaded.',
                artifactId,
                formatSizeLimit(maxBytes),
              ),
            ),
          );
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
        throw stalledError();
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
    await this._assertActions();
    await deleteActionRun({ path: { owner, repo, run_id: runId }, client: this.client });
  }

  /**
   * One page of notification threads. `before` is the page cursor (only
   * notifications updated before that instant), which keeps paging stable when
   * marking notifications read removes them from the filtered list. The total
   * (when the server reports one) lets a caller page exactly to the end
   * instead of relying on an empty page as the only proof of completeness
   * (see `NotificationPoller`).
   */
  async getNotifications(
    statusTypes: string[] = ['unread', 'pinned'],
    subjectType?: ('issue' | 'pull' | 'repository')[],
    limit: number = 50,
    before?: string,
  ): Promise<PagedList<ForgejoNotification>> {
    return this._getListPage<ForgejoNotification>('/notifications', {
      'status-types': statusTypes,
      ...(subjectType ? { 'subject-type': subjectType } : {}),
      limit,
      ...(before ? { before } : {}),
    });
  }

  async markNotificationRead(id: number): Promise<void> {
    await notifyReadThread({ path: { id }, client: this.client });
  }

  async markAllNotificationsRead(): Promise<void> {
    await notifyReadList({ query: { all: true, 'to-status': 'read' }, client: this.client });
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
   * instead, exactly like `getFileContentResult` answers those kinds — and
   * `noticeKind`/`noticeTarget` beside it, the structured form of that sentence
   * (which kind, and the target path or git URL the API named, when it named
   * one). The extension host's dashboard is a Chinese-or-English UI and builds
   * its own localized sentence from those two fields; the English `notice`
   * stays for the headless MCP tools, which have no translator.
   *
   * `getRepoDetail` calls this once and exposes the result as
   * `readme`/`readmeNotice`/`readmeSize`, so a detail load needs no second
   * probe.
   */
  async getReadmeEntry(owner: string, repo: string, ref?: string): Promise<ReadmeEntry | undefined> {
    const readmeFile = await this._probe(
      repoGetContents({
        path: { owner, repo, filepath: README_PATH },
        ...(ref ? { query: { ref } } : {}),
        client: this.client,
      }),
      `getReadmeEntry ${owner}/${repo}`,
    );
    if (!readmeFile || Array.isArray(readmeFile)) {
      return undefined;
    }
    const entry: ReadmeEntry = {};
    // Content the server did send is always file content, whatever the entry
    // says, and the `size` alongside it is then the file's own size.
    if (readmeFile.content) {
      entry.content = decodeBase64(readmeFile.content);
    } else {
      switch ((readmeFile as { type?: string }).type) {
        case 'symlink': {
          // `size` here is the *link target's* length, not a payload size. The
          // notice reaches the webview's README preview, so it is localized
          // through the host seam (English passthrough for the headless MCP
          // host), like the CI-log and artifact messages. The kind and the
          // target are carried beside it so a caller with its own translator
          // builds the sentence itself instead of showing this English one.
          const target = (readmeFile as { target?: string }).target;
          entry.notice = readmeSymlinkNotice(getForgejoClientHost().t, target);
          entry.noticeKind = 'symlink';
          if (target) {
            entry.noticeTarget = target;
          }
          return entry;
        }
        case 'submodule': {
          const gitUrl = (readmeFile as { submodule_git_url?: string }).submodule_git_url;
          entry.notice = readmeSubmoduleNotice(getForgejoClientHost().t, gitUrl);
          entry.noticeKind = 'submodule';
          if (gitUrl) {
            entry.noticeTarget = gitUrl;
          }
          return entry;
        }
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
      repoGet({ path: { owner, repo }, client: this.client }),
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
   *
   * The README is answered by `readme` (its text, or the client's English
   * sentence for an entry that is not a regular file), `readmeNotice` (that
   * sentence's structured form: which kind it is and the link target or git URL
   * the API named) and `readmeSize` (the size of a payload the instance
   * withheld). A localized caller builds its own sentence from `readmeNotice`.
   */
  async getRepoDetail(owner: string, repo: string): Promise<ForgejoRepoDetailWithCaps> {
    const repository = await repoGet({ path: { owner, repo }, client: this.client });
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
      repoListBranches({
        path: { owner, repo },
        query: { limit: REPO_DETAIL_LIST_LIMIT + 1 },
        client: this.client,
      }),
      repoGetAllCommits({
        path: { owner, repo },
        query: { limit: REPO_DETAIL_LIST_LIMIT + 1 },
        client: this.client,
      }),
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
      // The same non-file answer in structured form, so the extension host can
      // word it in the UI's own language (the English `readme` above stays for
      // the MCP tools). `noticeKind` is only set by the symlink/submodule
      // branches, where there is no content to prefer.
      readmeNotice: readmeEntry?.noticeKind
        ? { kind: readmeEntry.noticeKind, target: readmeEntry.noticeTarget }
        : undefined,
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
    const repository = await repoGet({ path: { owner, repo }, client: this.client });
    return (repository as ForgejoRepository).default_branch ?? 'main';
  }

  async getRepoBranchCommits(owner: string, repo: string, branch?: string): Promise<ForgejoCommit[]> {
    const commits = await repoGetAllCommits({
      path: { owner, repo },
      query: branch ? { sha: branch, limit: 10 } : { limit: 10 },
      client: this.client,
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
   * The commit history of one file, paged up to the shared list cap, together
   * with the server's own commit count for that file (see `PagedList`).
   *
   * A single `limit: 50` request presented the newest 50 commits as the whole
   * history: a busier file silently lost everything older, with no truncation
   * signal to notice it by. The endpoint takes `page`/`limit`, so the history is
   * read the same way every other capped list is; the server's `X-Total-Count`
   * turns "this reached the cap" into the exact answer (a file with exactly
   * `LIST_ITEM_LIMIT` commits is complete) for the callers that read it, and
   * the length heuristic stays the fallback when the server reports none.
   */
  async getFileHistoryWithTotal(
    owner: string,
    repo: string,
    filepath: string,
    ref?: string,
  ): Promise<PagedList<ForgejoCommit>> {
    const commits = await this._fetchAllPagesMeta<Commit>(
      (page) =>
        this._getListPage<Commit>(
          this._repoPath(owner, repo, '/commits'),
          ref ? { sha: ref, path: filepath, page, limit: PAGE_SIZE } : { path: filepath, page, limit: PAGE_SIZE },
        ),
      { label: 'file history' },
    );
    const items = commits.items.map(
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
    return { items, totalCount: commits.totalCount };
  }

  /** The rows of `getFileHistoryWithTotal`. */
  async getFileHistory(owner: string, repo: string, filepath: string, ref?: string): Promise<ForgejoCommit[]> {
    return (await this.getFileHistoryWithTotal(owner, repo, filepath, ref)).items;
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
    // The key carries the full instance URL (not the bare origin) and the token
    // hash for the same reason the tree cache does (see `_getRepoTree`): two
    // deployments can share a host under different sub-paths, and two accounts
    // on one instance see different bytes for the same path — this memo is
    // shared across client instances.
    const cacheKey = this.abortSignal
      ? undefined
      : cacheKeyFor(this.configuredInstanceUrl, this.tokenCacheKey, owner, repo, path, ref ?? '');
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
      entries = ((await repoGetContentsList({ path: { owner, repo }, query: params, client: this.client })) ??
        []) as ForgejoContentEntry[];
    } else {
      const result = await repoGetContents({
        path: { owner, repo, filepath: path },
        query: params,
        client: this.client,
      });
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
    // The full instance URL keys the cache, not the bare origin: two
    // deployments sharing a host under different sub-paths (`/a` vs `/b`) are
    // different servers, and with a shared token an origin-level key would let
    // one answer the other's search from a stale tree.
    const key = cacheKeyFor(this.configuredInstanceUrl, this.tokenCacheKey, owner, repo, ref);
    const cached = treeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return { entries: cached.value, truncated: cached.truncated };
    }
    treeCache.delete(key);

    const allFiles: GitEntry[] = [];
    let truncated = false;
    let previousFirstSha: string | undefined;
    for (let page = 1; page <= MAX_TREE_PAGES; page++) {
      const response = await getTree({
        path: { owner, repo, sha: ref },
        query: { recursive: true, page, per_page: 100 },
        client: this.client,
      });
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

  /**
   * The repository's branches with the server's own branch count (see
   * `PagedList`). The count is what tells a repository with exactly
   * `LIST_ITEM_LIMIT` branches that the list is complete, instead of announcing
   * a truncation the read did not suffer.
   */
  async getRepoBranchesWithTotal(owner: string, repo: string): Promise<PagedList<ForgejoBranch>> {
    return this._fetchAllPagesMeta<ForgejoBranch>(
      (page) => this._getListPage<ForgejoBranch>(this._repoPath(owner, repo, '/branches'), { page, limit: PAGE_SIZE }),
      { label: 'branches' },
    );
  }

  /** The rows of `getRepoBranchesWithTotal`. */
  async getRepoBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    return (await this.getRepoBranchesWithTotal(owner, repo)).items;
  }

  /** The repository's tags with the server's own tag count (see `getRepoBranchesWithTotal`). */
  async getRepoTagsWithTotal(owner: string, repo: string): Promise<PagedList<ForgejoTag>> {
    return this._fetchAllPagesMeta<ForgejoTag>(
      (page) => this._getListPage<ForgejoTag>(this._repoPath(owner, repo, '/tags'), { page, limit: PAGE_SIZE }),
      { label: 'tags' },
    );
  }

  /** The rows of `getRepoTagsWithTotal`. */
  async getRepoTags(owner: string, repo: string): Promise<ForgejoTag[]> {
    return (await this.getRepoTagsWithTotal(owner, repo)).items;
  }

  /** The repository's releases with the server's own release count (see `getRepoBranchesWithTotal`). */
  async getRepoReleasesWithTotal(owner: string, repo: string): Promise<PagedList<ForgejoRelease>> {
    return this._fetchAllPagesMeta<ForgejoRelease>(
      (page) => this._getListPage<ForgejoRelease>(this._repoPath(owner, repo, '/releases'), { page, limit: PAGE_SIZE }),
      { label: 'releases' },
    );
  }

  /** The rows of `getRepoReleasesWithTotal`. */
  async getRepoReleases(owner: string, repo: string): Promise<ForgejoRelease[]> {
    return (await this.getRepoReleasesWithTotal(owner, repo)).items;
  }

  createBranch(owner: string, repo: string, data: CreateBranchRepoOption): Promise<ForgejoBranch> {
    return repoCreateBranch({ path: { owner, repo }, body: data, client: this.client }) as Promise<ForgejoBranch>;
  }

  deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    return repoDeleteBranch({ path: { owner, repo, branch }, client: this.client }) as Promise<void>;
  }

  createTag(owner: string, repo: string, data: CreateTagOption): Promise<ForgejoTag> {
    return repoCreateTag({ path: { owner, repo }, body: data, client: this.client }) as Promise<ForgejoTag>;
  }

  deleteTag(owner: string, repo: string, tag: string): Promise<void> {
    return repoDeleteTag({ path: { owner, repo, tag }, client: this.client }) as Promise<void>;
  }

  createRelease(owner: string, repo: string, data: CreateReleaseOption): Promise<ForgejoRelease> {
    return repoCreateRelease({ path: { owner, repo }, body: data, client: this.client }) as Promise<ForgejoRelease>;
  }

  editRelease(owner: string, repo: string, id: number, data: EditReleaseOption): Promise<ForgejoRelease> {
    return repoEditRelease({ path: { owner, repo, id }, body: data, client: this.client }) as Promise<ForgejoRelease>;
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
    return repoCreateReleaseAttachment({
      path: { owner, repo, id },
      body: { attachment },
      query: { name: filename },
      client: this.client,
    }).then((result) => {
      const data = result as Attachment;
      return {
        ...data,
        browser_download_url: data.browser_download_url ?? attachmentDownloadUrl(this.url, data.uuid),
      };
    });
  }

  deleteReleaseAttachment(owner: string, repo: string, id: number, attachmentId: number): Promise<void> {
    return repoDeleteReleaseAttachment({
      path: { owner, repo, id, attachment_id: attachmentId },
      client: this.client,
    }) as Promise<void>;
  }

  deleteRelease(owner: string, repo: string, id: number): Promise<void> {
    return repoDeleteRelease({ path: { owner, repo, id }, client: this.client }) as Promise<void>;
  }

  async getIssueDetail(owner: string, repo: string, index: number): Promise<ForgejoIssueDetail> {
    const [issue, repoInfo] = await Promise.all([
      issueGetIssue({ path: { owner, repo, index }, client: this.client }),
      this._probe(repoGet({ path: { owner, repo }, client: this.client }), `getIssueDetail repo ${owner}/${repo}`),
    ]);
    const permissions = (repoInfo as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } } | undefined)
      ?.permissions;
    return {
      ...(issue as ForgejoIssueDetail),
      repoPermissions: permissions,
    };
  }

  /**
   * The pull request record alone, without the detail assembly
   * (`getPullRequestDetail` also reads the issue, the repository, branch
   * protection and the combined status). The AI pre-review only needs the
   * header fields it is allowed to send, and paying for four extra requests
   * there would be cost with no reader.
   */
  async getPullRequest(owner: string, repo: string, index: number): Promise<ForgejoPullRequestDetail> {
    return (await repoGetPullRequest({
      path: { owner, repo, index },
      client: this.client,
    })) as ForgejoPullRequestDetail;
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
      repoGetPullRequest({ path: { owner, repo, index }, client: this.client }),
      this._probe(
        issueGetIssue({ path: { owner, repo, index }, client: this.client }),
        `getPullRequestDetail issue #${index}`,
      ),
      this._probe(
        repoGet({ path: { owner, repo }, client: this.client }),
        `getPullRequestDetail repo ${owner}/${repo}`,
      ),
    ]);
    const permissions = (repoInfo as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } } | undefined)
      ?.permissions;
    const prDetail = pr as ForgejoPullRequestDetail;
    const baseRef = prDetail.base?.ref;
    const headSha = prDetail.head?.sha;
    const combinedStatusPromise = headSha
      ? this._probe(
          repoGetCombinedStatusByRef({ path: { owner, repo, ref: headSha }, client: this.client }),
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
      const protection = (await repoGetBranchProtection({
        path: { owner, repo, name: branch },
        client: this.client,
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

  async getRepoIssues(
    owner: string,
    repo: string,
    state: string = 'open',
    query?: string,
  ): Promise<PagedList<ForgejoIssue>> {
    const q = query?.trim();
    return this._fetchAllPagesMeta(
      (page) =>
        this._getListPage<ForgejoIssue>(`/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues`, {
          state,
          type: 'issues',
          ...(q ? { q } : {}),
          page,
          limit: PAGE_SIZE,
        }),
      { label: 'issues' },
    );
  }

  /** The repository's labels with the server's own label count (see `getRepoBranchesWithTotal`). */
  async getRepoLabelsWithTotal(owner: string, repo: string): Promise<PagedList<Label>> {
    return this._fetchAllPagesMeta<Label>(
      (page) => this._getListPage<Label>(this._repoPath(owner, repo, '/labels'), { page, limit: PAGE_SIZE }),
      { label: 'labels' },
    );
  }

  /** The rows of `getRepoLabelsWithTotal`. */
  async getRepoLabels(owner: string, repo: string): Promise<Label[]> {
    return (await this.getRepoLabelsWithTotal(owner, repo)).items;
  }

  async getRepoAssignees(owner: string, repo: string): Promise<string[]> {
    const users = await repoGetAssignees({ path: { owner, repo }, client: this.client });
    return ((users ?? []) as User[]).map((user) => user.login ?? '').filter(Boolean);
  }

  /** The repository's open milestones with the server's own count (see `getRepoBranchesWithTotal`). */
  async getRepoMilestonesWithTotal(owner: string, repo: string): Promise<PagedList<Milestone>> {
    return this._fetchAllPagesMeta<Milestone>(
      (page) =>
        this._getListPage<Milestone>(this._repoPath(owner, repo, '/milestones'), {
          state: 'open',
          page,
          limit: PAGE_SIZE,
        }),
      { label: 'milestones' },
    );
  }

  /** The rows of `getRepoMilestonesWithTotal`. */
  async getRepoMilestones(owner: string, repo: string): Promise<Milestone[]> {
    return (await this.getRepoMilestonesWithTotal(owner, repo)).items;
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
        ? userSearch({ query: { q: query, limit: 10 }, client: this.client })
            .then((result) => (result?.data ?? []) as User[])
            // Best-effort like `_probe`: a failed suggestion lookup must not
            // break the composer, but the failure is logged so a systematically
            // failing endpoint stays diagnosable.
            .catch((error: unknown) => {
              this.logger?.debug(
                `[probe] searchMentions users: ${redactErrorDetail(error instanceof Error ? error.message : String(error))}`,
              );
              return [] as User[];
            })
        : Promise.resolve([] as User[]),
      searchIssues
        ? issueListIssues({
            path: { owner, repo },
            query: { state: 'all', q: query, limit: 10 },
            client: this.client,
          })
            .then((issues) => (issues ?? []) as ForgejoIssue[])
            .catch((error: unknown) => {
              this.logger?.debug(
                `[probe] searchMentions issues: ${redactErrorDetail(error instanceof Error ? error.message : String(error))}`,
              );
              return [] as ForgejoIssue[];
            })
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
    const user = await this._probe(userGet({ path: { username }, client: this.client }), `getUserPreview ${username}`);
    return user as ForgejoUser | undefined;
  }

  async getIssuePreview(owner: string, repo: string, index: number): Promise<ForgejoIssue | undefined> {
    const issue = await this._probe(
      issueGetIssue({ path: { owner, repo, index }, client: this.client }),
      `getIssuePreview #${index}`,
    );
    return issue as ForgejoIssue | undefined;
  }

  async getRepoPullRequests(
    owner: string,
    repo: string,
    state: string = 'open',
    query?: string,
    options?: RepoPullRequestOptions,
  ): Promise<PagedList<ForgejoPullRequest>> {
    const q = query?.trim();
    const stopWhen = options?.stopWhen;
    if (q) {
      // repoListPullRequests has no keyword filter; the issues endpoint supports `q` with `type=pulls`.
      const pulls = await this._fetchAllPagesMeta(
        (page) =>
          this._getListPage<ForgejoPullRequest>(
            `/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/issues`,
            {
              state,
              type: 'pulls',
              q,
              page,
              limit: PAGE_SIZE,
            },
          ),
        { label: 'pull requests', stopWhen },
      );
      // The issues endpoint returns issue-shaped rows (the old code cast them the
      // same way); drop any null entry first so consumers can dereference freely.
      return { items: this._definedPullRequests(pulls.items), totalCount: pulls.totalCount };
    }
    const pulls = await this._fetchAllPagesMeta(
      (page) =>
        this._getListPage<ForgejoPullRequest>(`/repos/${encodePathSegment(owner)}/${encodePathSegment(repo)}/pulls`, {
          state,
          // The endpoint's own head-branch filter (see RepoPullRequestOptions).
          // `buildUrl` drops an undefined value, so a caller that does not ask
          // for it sends exactly the request it sent before.
          head: options?.head,
          page,
          limit: PAGE_SIZE,
        }),
      { label: 'pull requests', stopWhen },
    );
    return { items: this._definedPullRequests(pulls.items), totalCount: pulls.totalCount };
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
    return issueCreateIssue({ path: { owner, repo }, body: data, client: this.client }) as Promise<ForgejoIssue>;
  }

  editIssue(owner: string, repo: string, index: number, data: EditIssueOption): Promise<ForgejoIssue> {
    return issueEditIssue({ path: { owner, repo, index }, body: data, client: this.client }) as Promise<ForgejoIssue>;
  }

  deleteIssue(owner: string, repo: string, index: number): Promise<unknown> {
    return issueDelete({ path: { owner, repo, index }, client: this.client });
  }

  replaceIssueLabels(owner: string, repo: string, index: number, labels: number[]): Promise<Label[]> {
    return issueReplaceLabels({
      path: { owner, repo, index },
      body: { labels },
      client: this.client,
    }) as Promise<Label[]>;
  }

  checkIssueSubscription(owner: string, repo: string, index: number): Promise<WatchInfo> {
    return issueCheckSubscription({ path: { owner, repo, index }, client: this.client }) as Promise<WatchInfo>;
  }

  addIssueSubscription(owner: string, repo: string, index: number, user: string): Promise<unknown> {
    return issueAddSubscription({ path: { owner, repo, index, user }, client: this.client });
  }

  deleteIssueSubscription(owner: string, repo: string, index: number, user: string): Promise<unknown> {
    return issueDeleteSubscription({ path: { owner, repo, index, user }, client: this.client });
  }

  startIssueStopwatch(owner: string, repo: string, index: number): Promise<unknown> {
    return issueStartStopWatch({ path: { owner, repo, index }, client: this.client });
  }

  stopIssueStopwatch(owner: string, repo: string, index: number): Promise<unknown> {
    return issueStopStopWatch({ path: { owner, repo, index }, client: this.client });
  }

  deleteIssueStopwatch(owner: string, repo: string, index: number): Promise<unknown> {
    return issueDeleteStopWatch({ path: { owner, repo, index }, client: this.client });
  }

  async listIssueTrackedTimes(owner: string, repo: string, index: number): Promise<TrackedTime[]> {
    const times = await this._fetchAllPages(
      (page) =>
        issueTrackedTimes({
          path: { owner, repo, index },
          query: { page, limit: PAGE_SIZE },
          client: this.client,
        }),
      { label: 'tracked times' },
    );
    return times as TrackedTime[];
  }

  // The server answers 422 when time is missing or zero (the generated error type
  // only declares 400/403/404; regenerating from a pinned spec would add it).
  addIssueTime(owner: string, repo: string, index: number, time: number): Promise<TrackedTime> {
    const data: AddTimeOption = { time };
    return issueAddTime({ path: { owner, repo, index }, body: data, client: this.client }) as Promise<TrackedTime>;
  }

  resetIssueTime(owner: string, repo: string, index: number): Promise<unknown> {
    return issueResetTime({ path: { owner, repo, index }, client: this.client });
  }

  deleteIssueTime(owner: string, repo: string, index: number, id: number): Promise<unknown> {
    return issueDeleteTime({ path: { owner, repo, index, id }, client: this.client });
  }

  async listIssueDependencies(owner: string, repo: string, index: number): Promise<ForgejoIssue[]> {
    // The endpoint pages like every other list (default 30, capped at
    // MaxResponseItems) and sends no total count, so an unpaged call silently
    // truncated issues with more than 30 dependencies. `_fetchAllPages` walks the
    // pages until one comes back short.
    return (await this._fetchAllPages(
      (page) =>
        issueListIssueDependencies({
          path: { owner, repo, index },
          query: { page, limit: PAGE_SIZE },
          client: this.client,
        }),
      { label: 'issue dependencies' },
    )) as ForgejoIssue[];
  }

  createIssueDependency(owner: string, repo: string, index: number, dependencyIndex: number): Promise<unknown> {
    const data: IssueMeta = { index: dependencyIndex, owner, repo };
    return issueCreateIssueDependencies({ path: { owner, repo, index }, body: data, client: this.client });
  }

  removeIssueDependency(owner: string, repo: string, index: number, dependencyIndex: number): Promise<unknown> {
    const data: IssueMeta = { index: dependencyIndex, owner, repo };
    return issueRemoveIssueDependencies({ path: { owner, repo, index }, body: data, client: this.client });
  }

  async getIssueReactions(owner: string, repo: string, index: number): Promise<Reaction[]> {
    const reactions = await this._fetchAllPages(
      (page) =>
        issueGetIssueReactions({
          path: { owner, repo, index },
          query: { page, limit: PAGE_SIZE },
          client: this.client,
        }),
      { label: 'issue reactions' },
    );
    return reactions as Reaction[];
  }

  addIssueReaction(owner: string, repo: string, index: number, content: string): Promise<Reaction> {
    return issuePostIssueReaction({
      path: { owner, repo, index },
      body: { content },
      client: this.client,
    }) as Promise<Reaction>;
  }

  removeIssueReaction(owner: string, repo: string, index: number, content: string): Promise<unknown> {
    return issueDeleteIssueReaction({
      path: { owner, repo, index },
      body: { content },
      client: this.client,
    });
  }

  getCommentReactions(owner: string, repo: string, commentId: number): Promise<Reaction[]> {
    return issueGetCommentReactions({ path: { owner, repo, id: commentId }, client: this.client }) as Promise<
      Reaction[]
    >;
  }

  addCommentReaction(owner: string, repo: string, commentId: number, content: string): Promise<Reaction> {
    return issuePostCommentReaction({
      path: { owner, repo, id: commentId },
      body: { content },
      client: this.client,
    }) as Promise<Reaction>;
  }

  removeCommentReaction(owner: string, repo: string, commentId: number, content: string): Promise<unknown> {
    return issueDeleteCommentReaction({
      path: { owner, repo, id: commentId },
      body: { content },
      client: this.client,
    });
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
    return issueCreateIssueAttachment({
      path: { owner, repo, index },
      body: { attachment },
      query: { name: filename },
      client: this.client,
    }).then((result) => {
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
        browser_download_url: data.browser_download_url ?? attachmentDownloadUrl(this.url, data.uuid),
      };
    });
  }

  deleteIssueAttachment(owner: string, repo: string, index: number, attachmentId: number): Promise<void> {
    return issueDeleteIssueAttachment({
      path: { owner, repo, index, attachment_id: attachmentId },
      client: this.client,
    }) as Promise<void>;
  }

  createPullRequest(owner: string, repo: string, data: CreatePullRequestOption): Promise<ForgejoPullRequest> {
    return repoCreatePullRequest({
      path: { owner, repo },
      body: data,
      client: this.client,
    }) as Promise<ForgejoPullRequest>;
  }

  editPullRequest(
    owner: string,
    repo: string,
    index: number,
    data: EditPullRequestOption,
  ): Promise<ForgejoPullRequest> {
    return repoEditPullRequest({
      path: { owner, repo, index },
      body: data,
      client: this.client,
    }) as Promise<ForgejoPullRequest>;
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
   * - an *empty* array is an empty directory or an empty repository —
   *   `GetContentsOrList` answers an empty list for every path once
   *   `repo.IsEmpty` is set — so it is reported as `empty-listing`, never as a
   *   directory, and the sentence names both possible causes;
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
    // The filepath is passed raw: the generated client's path serializer
    // percent-encodes it per segment and leaves the `/` separators alone, which
    // is exactly what this route needs (the contents API wildcard-matches the
    // rest of the path). Encoding it here as well would send `%252F`.
    const response = await repoGetContents({
      path: { owner, repo, filepath },
      ...(ref ? { query: { ref } } : {}),
      client: this.client,
    });
    if (Array.isArray(response)) {
      // An empty listing is not proof of a directory. `GetContentsOrList` answers
      // an empty list for *every* path once `repo.IsEmpty` is set — the root, a
      // path that does not exist, a path that names a file — so an empty
      // directory and a repository with no content are the same response, and
      // claiming "a directory" named a cause the server never gave (the same
      // mistake the symlink and submodule branches below exist to avoid). The two
      // cases are indistinguishable from this response, and asking the repository
      // endpoint for `empty` would spend a second request on every miss, so the
      // answer names both instead of picking one.
      return response.length === 0
        ? { kind: 'empty-listing', text: emptyListingNotice(filepath) }
        : { kind: 'directory', text: directoryNotice(filepath) };
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

  /**
   * The pull request's changed files with the server's own file count (see
   * `PagedList`). The count is what separates a changed-file list that reached
   * the shared cap from one the server says is complete.
   */
  async getPullRequestFilesWithTotal(
    owner: string,
    repo: string,
    index: number,
  ): Promise<PagedList<ForgejoChangedFile>> {
    const files = await this._fetchAllPagesMeta<ForgejoChangedFile>(
      (page) =>
        this._getListPage<ForgejoChangedFile>(this._repoPath(owner, repo, `/pulls/${index}/files`), {
          page,
          limit: PAGE_SIZE,
        }),
      { label: 'pull request files' },
    );
    // The API spells a deleted file's status 'deleted' (the compare endpoint
    // uses 'removed'); consumers only recognize 'removed', so normalize here.
    return {
      items: files.items.map((file) => (file.status === 'deleted' ? { ...file, status: 'removed' } : file)),
      totalCount: files.totalCount,
    };
  }

  /** The rows of `getPullRequestFilesWithTotal`. */
  async getPullRequestFiles(owner: string, repo: string, index: number): Promise<ForgejoChangedFile[]> {
    return (await this.getPullRequestFilesWithTotal(owner, repo, index)).items;
  }

  /**
   * The commits of a ref-to-ref comparison, from /compare.
   *
   * It exists for the feature that describes a pull request **before it is
   * created**: `getPullRequestCommits` needs a pull request index, and a form that
   * has not been submitted yet has none, while `/compare` answers for two branch
   * names. The two calls are deliberately separate from
   * `getPullRequestFilesFromCompare` even though they hit the same endpoint: a
   * caller that needs one half must not be handed a reading of the other it did
   * not ask for, and the summary line the caller logs states what it asked for.
   *
   * The comparison separator is `...` (merge base to head), which is the same
   * range a pull request shows: a `..` comparison would list every commit the base
   * branch gained since the fork point as if it were part of the change.
   *
   * Only the fields a description can use are kept, and they are read through
   * `unknown` rather than trusted: this is the server's own repo-commit shape,
   * which may grow (or be a different Forgejo version's). A commit without a sha
   * is dropped — a commit row that cannot be identified is not worth sending.
   */
  async getCompareCommits(owner: string, repo: string, base: string, head: string): Promise<ForgejoCompareCommit[]> {
    const compare = await this._compareRange(owner, repo, base, head);
    const raw = (compare.commits ?? []) as Array<{
      sha?: unknown;
      commit?: { message?: unknown; author?: { name?: unknown; date?: unknown } };
      author?: { login?: unknown; full_name?: unknown };
    }>;
    const commits: ForgejoCompareCommit[] = [];
    for (const entry of raw) {
      const sha = typeof entry.sha === 'string' ? entry.sha : '';
      if (sha === '') {
        continue;
      }
      const message = typeof entry.commit?.message === 'string' ? entry.commit.message : '';
      const lines = message.split('\n');
      const subject = (lines[0] ?? '').trim();
      const body = lines.slice(1).join('\n').trim();
      const authorName =
        (typeof entry.author?.full_name === 'string' && entry.author.full_name !== ''
          ? entry.author.full_name
          : undefined) ??
        (typeof entry.author?.login === 'string' && entry.author.login !== '' ? entry.author.login : undefined) ??
        (typeof entry.commit?.author?.name === 'string' && entry.commit.author.name !== ''
          ? entry.commit.author.name
          : undefined);
      const date = typeof entry.commit?.author?.date === 'string' ? entry.commit.author.date : undefined;
      commits.push({
        sha,
        subject,
        ...(body === '' ? {} : { body }),
        ...(authorName === undefined ? {} : { author: authorName }),
        ...(date === undefined ? {} : { date }),
      });
    }
    return commits;
  }

  /**
   * One `GET /compare` for a merge-base range, shared by the two halves above.
   *
   * It exists because the separator is **not** a detail: `base...head` asks for
   * the merge base, which is the range a pull request shows, while `base..head`
   * also lists every commit the base branch gained since the fork point. The two
   * halves of one comparison must not disagree about which range they describe,
   * and a measurement (2026-10-06) found that the changed-file half's own spelling
   * arrived at the server as `..`: the client's request path is rendered through
   * `slashPreservingPathSerializer`, which normalises `.`/`..` segments and
   * therefore cannot carry a literal `...` in a path parameter. Both halves
   * therefore read the endpoint through this method, and the range is rendered
   * here, once, where the single encoding is applied.
   */
  private async _compareRange(owner: string, repo: string, base: string, head: string) {
    // The comparison is one path segment, and the URL parser resolves dot
    // segments, so the assembled value is encoded as a single segment: a forged
    // `../` value cannot walk the request onto another endpoint. A value that is
    // exactly `.`/`..` is refused by `slashPreservingPathSerializer`, which checks
    // every string path parameter before it is rendered.
    return await repoCompareDiff({
      path: { owner, repo, basehead: `${base}...${head}` },
      client: this.client,
    });
  }

  /**
   * The changed files for a commit range, derived from /compare. That endpoint
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
    const compare = await this._compareRange(owner, repo, baseSha, headSha);
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

  /**
   * The comment and event timeline of an issue or pull request, paged up to the
   * shared list cap, with the server's own timeline row count (see
   * `PagedList`). Without the total, a timeline that reached the cap was
   * reported as possibly cut off even when the server holds exactly that many
   * rows.
   */
  async getPullRequestCommentsAndTimelineWithTotal(
    owner: string,
    repo: string,
    index: number,
  ): Promise<PagedList<TimelineComment>> {
    const page = await this._fetchAllPagesMeta<TimelineComment>(
      (p) =>
        this._getListPage<TimelineComment>(this._repoPath(owner, repo, `/issues/${index}/timeline`), {
          page: p,
          limit: PAGE_SIZE,
        }),
      // The timeline drops some rows (code comments, unreadable cross-repository
      // references) *after* the page has been read from the database, so a page
      // that comes back shorter than the page size does not mean the timeline
      // ended — keep paging until an empty page arrives.
      { label: 'timeline', shortPageMarksEnd: false },
    );
    return { items: await this._withCommentAttachments(owner, repo, page.items), totalCount: page.totalCount };
  }

  /** The rows of `getPullRequestCommentsAndTimelineWithTotal`. */
  async getPullRequestCommentsAndTimeline(owner: string, repo: string, index: number): Promise<TimelineComment[]> {
    return (await this.getPullRequestCommentsAndTimelineWithTotal(owner, repo, index)).items;
  }

  /**
   * Adds each comment's attachment list to the timeline rows.
   *
   * Body-reference heuristic: only comments whose body links an attachment
   * (see ATTACHMENT_REFERENCE_REGEX) get an attachment-list request, instead
   * of one API call per comment. Note the behavior change: attachments that
   * were uploaded but later unlinked from the body are no longer listed.
   */
  private async _withCommentAttachments(
    owner: string,
    repo: string,
    comments: TimelineComment[],
  ): Promise<TimelineComment[]> {
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
        const assets = (await issueListIssueCommentAttachments({
          path: { owner, repo, id: commentId },
          client: this.client,
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
            browser_download_url: a.browser_download_url ?? attachmentDownloadUrl(this.url, a.uuid),
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
    return issueCreateComment({
      path: { owner, repo, index },
      body: { body },
      client: this.client,
    }) as Promise<TimelineComment>;
  }

  editIssueComment(owner: string, repo: string, commentId: number, body: string): Promise<TimelineComment> {
    return issueEditComment({
      path: { owner, repo, id: commentId },
      body: { body },
      client: this.client,
    }) as Promise<TimelineComment>;
  }

  deleteIssueComment(owner: string, repo: string, commentId: number): Promise<void> {
    return issueDeleteComment({ path: { owner, repo, id: commentId }, client: this.client }) as Promise<void>;
  }

  deleteIssueCommentAttachment(owner: string, repo: string, commentId: number, attachmentId: number): Promise<void> {
    return issueDeleteIssueCommentAttachment({
      path: { owner, repo, id: commentId, attachment_id: attachmentId },
      client: this.client,
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
    return issueCreateIssueCommentAttachment({
      path: { owner, repo, id: commentId },
      body: { attachment },
      query: { name: filename },
      client: this.client,
    }).then((result) => {
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
        browser_download_url: data.browser_download_url ?? attachmentDownloadUrl(this.url, data.uuid),
      };
    });
  }

  /** The pull request's commits with the server's own commit count (see `getRepoBranchesWithTotal`). */
  async getPullRequestCommitsWithTotal(owner: string, repo: string, index: number): Promise<PagedList<Commit>> {
    return this._fetchAllPagesMeta<Commit>(
      (page) =>
        this._getListPage<Commit>(this._repoPath(owner, repo, `/pulls/${index}/commits`), {
          files: true,
          page,
          limit: PAGE_SIZE,
        }),
      { label: 'pull request commits' },
    );
  }

  /** The rows of `getPullRequestCommitsWithTotal`. */
  async getPullRequestCommits(owner: string, repo: string, index: number): Promise<Commit[]> {
    return (await this.getPullRequestCommitsWithTotal(owner, repo, index)).items;
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    index: number,
    strategy: 'merge' | 'rebase' | 'squash',
  ): Promise<void> {
    await repoMergePullRequest({ path: { owner, repo, index }, body: { Do: strategy }, client: this.client });
    // The merge moved the base branch, so every cached tree and file body for
    // this instance is now potentially pre-merge: the tree cache has no way to
    // know which ref changed, and serving a cached commit list or file from
    // before the merge is exactly the staleness the user sees right after
    // merging. Drop the whole shared memo instead of trying to guess.
    invalidateRepoContentCaches();
  }

  async getPullRequestDiff(owner: string, repo: string, index: number): Promise<string> {
    const response = await repoDownloadPullDiffOrPatch({
      path: { owner, repo, index, diffType: 'diff' },
      client: this.client,
      responseType: 'text',
      signal: AbortSignal.timeout(API_DOWNLOAD_TIMEOUT_MS),
    });
    return (response as unknown as string) ?? '';
  }

  /** The pull request's reviews with the server's own review count (see `getRepoBranchesWithTotal`). */
  async listPullReviewsWithTotal(owner: string, repo: string, index: number): Promise<PagedList<PullReview>> {
    return this._fetchAllPagesMeta<PullReview>(
      (page) =>
        this._getListPage<PullReview>(this._repoPath(owner, repo, `/pulls/${index}/reviews`), {
          page,
          limit: PAGE_SIZE,
        }),
      { label: 'pull request reviews' },
    );
  }

  /** The rows of `listPullReviewsWithTotal`. */
  async listPullReviews(owner: string, repo: string, index: number): Promise<PullReview[]> {
    return (await this.listPullReviewsWithTotal(owner, repo, index)).items;
  }

  async getPullReviewComments(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
  ): Promise<PullReviewComment[]> {
    const result = await repoGetPullReviewComments({
      path: { owner, repo, index, id: reviewId },
      client: this.client,
    });
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
    return repoCreatePullReview({
      path: { owner, repo, index },
      body: {
        event: 'COMMENT',
        comments: [comment],
      },
      client: this.client,
    }) as Promise<PullReview>;
  }

  async createPendingPullReview(
    owner: string,
    repo: string,
    index: number,
    comment: CreatePullReviewComment,
  ): Promise<PullReview> {
    // Pending reviews require a non-empty body even when comments are attached.
    // Use a placeholder; it will be replaced when the review is submitted.
    return repoCreatePullReview({
      path: { owner, repo, index },
      body: {
        event: 'PENDING',
        body: '.',
        comments: [comment],
      },
      client: this.client,
    }) as Promise<PullReview>;
  }

  async addPullReviewComment(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    comment: CreatePullReviewComment,
  ): Promise<PullReviewComment> {
    return repoCreatePullReviewComment({
      path: { owner, repo, index, id: reviewId },
      body: comment,
      client: this.client,
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
    return repoSubmitPullReview({
      path: { owner, repo, index, id: reviewId },
      body: { event, body: body ?? '' },
      client: this.client,
    }) as Promise<PullReview>;
  }

  async deletePullReview(owner: string, repo: string, index: number, reviewId: number): Promise<void> {
    await repoDeletePullReview({ path: { owner, repo, index, id: reviewId }, client: this.client });
  }

  async deletePullReviewComment(
    owner: string,
    repo: string,
    index: number,
    reviewId: number,
    commentId: number,
  ): Promise<void> {
    await repoDeletePullReviewComment({
      path: { owner, repo, index, id: reviewId, comment: commentId },
      client: this.client,
    });
  }

  async renderMarkdown(text: string, context?: string): Promise<string> {
    // Routed through _client() like every other call: debug logging, error
    // body truncation, and syncApiUrlsToInstanceUrl URL rewriting all apply.
    const result = await apiRenderMarkdown({
      body: { Text: text, Mode: 'gfm', Context: context },
      client: this.client,
      responseType: 'text',
      // The endpoint answers JSON or HTML for the same 200. The render target is
      // HTML, and the request asks for it by name: the generated operation types
      // `headers` as `never` (the spec declares no header parameters), while the
      // negotiated response content type is the generated client's own option —
      // it sets `Accept` and picks the matching response variant.
      contentType: { response: 'text/html' },
    });
    return (result as unknown as string) ?? '';
  }

  private _rewriteResponseData<T>(data: T): T {
    if (!this.syncApiUrlsToInstanceUrl) {
      return data;
    }

    // Per response shape, not per client instance: the view provider builds a
    // ForgejoClient for every message, so an instance field alone never spares
    // the next request the scan. The fingerprint only samples the first few
    // items of each array, so it stays cheap on a 500-item list.
    //
    // A shape verdict may only ever be recorded for a payload that holds no
    // http(s) URL value at all (`_containsHttpUrlValue` below): a URL-free
    // payload has nothing to rewrite no matter which origin is detected, and
    // the fingerprint marks URL-valued strings apart from plain text, so a
    // later same-structure payload whose values DO include URLs produces a
    // different fingerprint and can never hit the memo. Memoizing on structure
    // alone skipped the rewrite for a same-shaped payload that carried URLs
    // pointing at the detected origin.
    const shape = `${this.configuredOrigin}|${_shapeFingerprint(data)}`;
    if (noRewriteShapes.has(shape)) {
      return data;
    }

    const detected = this._serverOriginFor(data);
    if (!detected) {
      // The payload names no server origin at all: nothing can be rewritten.
      if (!this._containsHttpUrlValue(data)) {
        rememberShape(shape);
      }
      return data;
    }

    if (!this._hasUrlOnOrigin(data, detected)) {
      // Nothing in the payload points at the detected origin, so the rewrite
      // would change no value. Returning the payload as it arrived skips the
      // deep copy that used to be paid on every response — 85-150 ms for a
      // 500-item list. The shape is only memoized when the payload is URL-free
      // (see above): a payload whose URLs all sit on the configured origin, or
      // under keys the rewrite never touches, needs no copy either, but its
      // shape must not become a verdict for the same structure carrying
      // detected-origin URLs later.
      if (!this._containsHttpUrlValue(data)) {
        rememberShape(shape);
      }
      return data;
    }

    this.detectedServerOrigin = detected;
    return this._rewriteUrls(data, detected, this.configuredOrigin);
  }

  /**
   * Whether any string value in the payload is itself an http(s) URL — the
   * only values `_rewriteUrls` can change. This is the gate for the
   * no-rewrite shape memo: a payload with no URL values can never need a
   * rewrite, whatever origin the server is detected at.
   */
  private _containsHttpUrlValue(data: unknown): boolean {
    if (typeof data === 'string') {
      return isHttpUrlValue(data);
    }
    if (Array.isArray(data)) {
      return data.some((item) => this._containsHttpUrlValue(item));
    }
    if (data && typeof data === 'object') {
      return Object.values(data).some((item) => this._containsHttpUrlValue(item));
    }
    return false;
  }

  /**
   * The server origin a payload's API-provided URLs point at, or undefined when
   * it holds none.
   *
   * Detection walks the payload, so its result is memoized per configured
   * instance URL in `detectedOriginByConfigured`; that memo, not the
   * `detectedServerOrigin` instance field, is what survives the per-message
   * client rebuild.
   */
  private _serverOriginFor(data: unknown): string | undefined {
    const memoized = detectedOriginByConfigured.get(this.configuredInstanceUrl);
    if (memoized !== undefined) {
      return memoized;
    }
    const detected = this._detectServerOrigin(data);
    if (!detected) {
      return undefined;
    }
    detectedOriginByConfigured.set(this.configuredInstanceUrl, detected);
    this.detectedServerOrigin = detected;
    return detected;
  }

  /**
   * True when any string value is a URL on `origin` that the rewrite would
   * change.
   *
   * `website` and `original_url` are skipped like detection skips them: they
   * are display-only links that legitimately point away from the server.
   * `avatar_url` is NOT skipped here (it is excluded only from detection, where
   * an external avatar host must not win the origin vote): an avatar served by
   * the instance itself sits on the detected origin, and the webview resolves
   * avatars by same-origin comparison against the *configured* URL
   * (`viewProvider._resolveAvatarUrl`), so an avatar left on the detected
   * origin would never be fetched with the token and renders broken for an
   * instance the webview cannot reach directly.
   */
  private _hasUrlOnOrigin(data: unknown, origin: string): boolean {
    const visit = (value: unknown, key?: string): boolean => {
      if (typeof value === 'string') {
        if (key === 'website' || key === 'original_url') {
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

  private _client(): ClientInstance {
    // The generated operations are transport-agnostic: they send through the
    // Kubb client core, and the transport below is where this client's concerns
    // live. It is built once per ForgejoClient (never per request) so the
    // interceptors installed here are the ones every call runs through; the
    // dispatcher and the timeout are resolved inside the transport, per request,
    // because the extension installs the configured proxy during activation and
    // a client can be constructed before that happens.
    const baseURL = `${this.url.replace(/\/$/, '')}/api/v1`;
    const client = createClientCore({
      baseURL,
      // Forgejo's contents route is a wildcard that matches the rest of the
      // path, and its router matches on the escaped path (RawPath) before
      // unescaping — so `{filepath}` must go out with its `/` separators intact
      // and only the segments encoded. Kubb's default serializer percent-encodes
      // the whole value, which turned `src/index.ts` into `src%2Findex.ts` and
      // 404'd every nested path. See `slashPreservingPathSerializer`.
      serializer: { path: slashPreservingPathSerializer },
      // A cancelled MCP tool call aborts its requests, and a configured proxy is
      // a Node fetch dispatcher plus the undici fetch that understands it.
      defaultTransport: sharedRequestTransport({
        // No token means anonymous access to a public instance. A blank
        // credential must leave the header off entirely: `Authorization: token `
        // with an empty value makes some servers reject the request outright
        // instead of treating it as anonymous.
        getAuthorization: () => (this.token.trim() ? `token ${this.token}` : undefined),
        resolveDispatcherPair: () => ({
          dispatcher: this.requestDispatcher ?? defaultRequestDispatcher,
          // A client-local dispatcher must be paired with its own fetch; only
          // the activation-wide pair is safe to reuse for the default one.
          fetchImpl: this.requestDispatcher ? this.requestFetch : defaultRequestFetch,
        }),
        resolveSignal: (request) => requestSignalFor(request.signal, this.abortSignal),
        onRequestFailed: (error, request) => {
          const debugEnabled = this.logger?.isDebugEnabled() ?? false;
          if (debugEnabled) {
            const started = this._requestStartedAt;
            const duration = started === undefined ? 0 : Date.now() - started;
            // The URL is redacted here for the same reason the request line is: a
            // configured instance URL may embed the access token.
            this.logger?.debug(
              `Request failed after ${duration}ms: ${request.method} ${redactUrlUserinfo(request.url)}`,
            );
          }
          if (error instanceof Error) {
            this._notifyIfPermissionError(error);
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
          return toApiError(error, requestContextFor(request.url, { viaProxy }));
        },
      }),
    });

    client.interceptors.request.use((request, config) => {
      // The transport is handed the resolved request only, so the caller's own
      // options are recorded here: `responseType` decides how the shared client
      // parses the body (a `text` call must not be JSON-parsed).
      rememberResponseType(request, config?.responseType);
      const debugEnabled = this.logger?.isDebugEnabled() ?? false;
      if (debugEnabled) {
        this._requestStartedAt = Date.now();
      }
      // A configured instance URL may embed the access token
      // (`https://user:token@host`), and the request URL carries that userinfo.
      // These lines reach the output channel and the MCP server's stderr, so the
      // userinfo is blanked before logging. The request itself is unaffected:
      // the token travels in the Authorization header.
      this.logger?.debug(`Request: ${request.method} ${redactUrlUserinfo(request.url)}`);
      return request;
    });

    client.interceptors.response.use((result, config) => {
      const debugEnabled = this.logger?.isDebugEnabled() ?? false;
      if (debugEnabled) {
        const started = this._requestStartedAt;
        const duration = started === undefined ? 0 : Date.now() - started;
        this.logger?.debug(`Response: ${result.status} ${result.statusText} (${duration}ms)`);
        const responseType = config?.responseType;
        if (responseType === 'stream') {
          this.logger?.debug('Response body: <stream> (not logged)');
        } else if (responseType === 'text' || responseType === 'arraybuffer') {
          // Raw payloads (CI logs, diffs, artifacts) can be huge and may
          // contain secrets in plain text; log metadata only.
          this.logger?.debug(`Response body: <${responseType}> (not logged)`);
        } else {
          this.logger?.debug(`Response body: ${JSON.stringify(result.data).slice(0, 2000)}`);
        }
      }
      return {
        ...result,
        // Streams are passed through untouched: rewriting walks JSON-shaped
        // payloads and would mangle a ReadableStream into an empty object.
        data: config?.responseType === 'stream' ? result.data : this._rewriteResponseData(result.data),
      };
    });

    // Errors that never became a response — a network failure, a refused
    // connection, a non-2xx answered by the shared client, which throws before
    // this client core ever sees a result — are logged and classified inside the
    // transport's `onRequestFailed` (above), which is the only place that runs
    // for every failure. The generated error interceptor channel is therefore
    // left to the operations that own it.

    return client as ClientInstance;
  }

  /**
   * Routes auth failures (401, scope-related 403) to the registered host:
   * the extension shows fix-guidance toasts, headless consumers ignore them.
   *
   * The host also receives a fingerprint of the credential the request carried,
   * because this is the only layer that has it: the extension keeps the token in
   * SecretStorage and hands the client a URL that says nothing about it, so a
   * host deduping the toast on the URL alone could never re-arm it after the
   * user rotated the token — the next 401 would stay silent for the rest of the
   * session. `undefined` when the request was anonymous (no credential was sent).
   *
   * The shared client states the status on a structured `RequestError`, so read
   * it there; a foreign error (another module's, a test fixture) has only the
   * message, which stays the fallback. The prose the 403 branch searches still
   * comes from the message: that text is the body's rendering, and a non-JSON
   * body is described rather than quoted, so searching the field would widen
   * the match.
   */
  private _notifyIfPermissionError(error: Error) {
    const messageMatch = error.message.match(/Forgejo API error (\d+):\s*([\s\S]+)/);
    const status = error instanceof RequestError ? String(error.status) : messageMatch?.[1];
    if (status === undefined) {
      return;
    }
    const text = (messageMatch?.[2] ?? '').trim();
    const host = getForgejoClientHost();
    const credentialFingerprint = failedCredentialFingerprint(this.token);

    if (status === '401') {
      host.notifyInvalidCredentials(this.url, credentialFingerprint);
      return;
    }

    if (status !== '403' || !/required scope|token does not have/i.test(text)) {
      return;
    }
    // Forgejo names the missing scope in the error body ("token does not have
    // at least one of required scope(s): [write:issue]").
    const scopeMatch = text.match(/required scope\(s\): \[([^\]]+)\]/i);
    host.notifyInsufficientScope(this.url, { scope: scopeMatch?.[1], body: text }, credentialFingerprint);
  }
}

/**
 * A digest of the credential a failed request carried, for the host's toast
 * dedupe: it must change when the credential does (so rotating a dead token
 * re-arms the toast) and stay stable otherwise (so a poller repeating the same
 * bad token does not re-toast). Truncated SHA-256 plus the length, in the same
 * shape as the webview's `tokenFingerprint`.
 *
 * The credential itself never leaves this function and never reaches a log,
 * a toast or a key that could be logged: the digest is all the caller gets.
 * `undefined` for a blank credential — such a request goes out anonymously (see
 * `_client`), so there is no credential whose rotation could matter.
 */
function failedCredentialFingerprint(token: string): string | undefined {
  if (!token.trim()) {
    return undefined;
  }
  return `${createHash('sha256').update(token).digest('hex').slice(0, 16)}-${token.length}`;
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

function decodeBase64(content: string): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(content, 'base64').toString('utf-8');
  }
  return atob(content);
}

/**
 * The entry kinds the contents endpoint can answer with. `file` is the only one
 * that carries content; `withheld` is a regular file whose payload the instance
 * did not send; `directory`/`symlink`/`submodule` are entries that never have a
 * payload at all; and `empty-listing` is a listing that came back with no
 * entries, which is an empty directory *or* an empty repository (see
 * `ForgejoClient.getFileContentResult`).
 */
export type FileContentKind = 'file' | 'withheld' | 'directory' | 'empty-listing' | 'symlink' | 'submodule';

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
 * The answer for a path whose listing came back with no entries.
 *
 * Forgejo's `GetContentsOrList` returns an empty list whenever `repo.IsEmpty` is
 * set, so every path of a repository with no content — a file that does not
 * exist yet included — answers this way, and an empty directory inside a
 * repository that does have commits answers exactly the same. The response
 * cannot tell the two apart, and this client does not spend a second request on
 * the repository endpoint to find out, so the sentence names both possibilities
 * rather than inventing one.
 */
function emptyListingNotice(path: string): string {
  return `${path} answered with an empty listing. Forgejo sends the same empty list for an empty directory or an empty repository — every path of a repository with no content answers this way — so this response does not say which one it is: use list_repo_contents to list the entries at this path, and check the repository's own state when the difference matters.`;
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
 * where the text lives rather than asking for a different path. That preview is
 * webview UI, so the sentence is localized through the host's TranslateFn (the
 * headless MCP host passes the English text through).
 */
function readmeSymlinkNotice(t: TranslateFn, target?: string): string {
  return target
    ? t(
        '{0} is a symlink to {1}, so Forgejo returned no text for it. Open {1} in the Forgejo web UI to read it.',
        README_PATH,
        target,
      )
    : t(
        '{0} is a symlink that points elsewhere in the repository, so Forgejo returned no text for it. Open it in the Forgejo web UI to read it.',
        README_PATH,
      );
}

/**
 * The answer for a README that is a submodule: the entry names its own
 * repository and carries no payload at all (its size is 0), so there is no text
 * this repository can show and none was withheld. Localized through the host's
 * TranslateFn for the same reason as `readmeSymlinkNotice`.
 */
function readmeSubmoduleNotice(t: TranslateFn, gitUrl?: string): string {
  return gitUrl
    ? t(
        '{0} is a submodule whose own repository is at {1}, so this repository holds no README text for it. Open the submodule in the Forgejo web UI to read it there.',
        README_PATH,
        gitUrl,
      )
    : t(
        '{0} is a submodule, a separate repository, so this repository holds no README text for it. Open it in the Forgejo web UI.',
        README_PATH,
      );
}

/**
 * The download URL for an attachment whose response carried no
 * `browser_download_url`. A missing `uuid` yields undefined rather than a
 * working-looking `/attachments/undefined` link that only 404s when opened, and
 * the instance URL's trailing slash is stripped so the join cannot produce a
 * double slash.
 */
function attachmentDownloadUrl(instanceUrl: string, uuid: string | undefined): string | undefined {
  if (!uuid) {
    return undefined;
  }
  return `${instanceUrl.replace(/\/+$/, '')}/attachments/${uuid}`;
}

/**
 * A byte cap rendered for an error message, in the largest unit the value
 * divides evenly into: the default artifact cap reads "2 GB", while the small
 * caps tests pass stay exact instead of rounding to "0 GB".
 */
function formatSizeLimit(bytes: number): string {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes % gib === 0) {
    return `${bytes / gib} GB`;
  }
  if (bytes % mib === 0) {
    return `${bytes / mib} MB`;
  }
  return `${bytes} bytes`;
}

// The generated API clients percent-encode each path parameter themselves now
// (through the path serializer in `src/generated/.kubb/serializers.ts`), so this
// layer no longer pre-encodes them: doing both would send `%252F`.
//
// Their default is `encodeURIComponent` per parameter, which is right for a
// single-segment route — `branches/{branch}` with `feature/x#1` must go out as
// `feature%2Fx%231`, and a global middleware forces chi to route on the escaped
// path (RawPath) with `ctx.Params` unescaping afterwards, so `%2F` survives
// matching (routers/common/middleware.go, services/context/base.go in the
// Forgejo tree). The only case that still 404s is a reverse proxy in front of
// Forgejo that decodes %2F before forwarding; that is a deployment issue the
// client cannot fix.
//
// `/repos/{owner}/{repo}/contents/{filepath}` is the exception: it is a wildcard
// route that matches the remainder of the path, so its `/` separators must stay
// literal — encoding them makes Forgejo answer 404 for every nested path. Its
// segments are therefore encoded one by one and rejoined, which is what the v4
// call layer did by hand (`encodeFilePath`) before the generated client learned
// to encode at all. `?` and `#` must be escaped inside a segment: leaving them
// would end the path (or start a fragment) early and send the rest as a query.
//
// The dot-segment refusal `encodePathSegment` used to perform has to survive
// here, and it is applied to *every* string path parameter — not only to
// `filepath`. The URL parser resolves `.` and `..` (literal or percent-encoded)
// as navigation, so a filepath of `../../../user/keys` would make the request
// escape the route it was built for; but so does a bare `..` in a
// single-segment parameter such as `branch`, `sha` or `tag`, where a value of
// `..` drops that parameter's own segment entirely (DELETE
// `…/branches/..` becomes a DELETE on the repository root). Encoding a segment
// cannot stop either case — `encodeURIComponent` does not encode `.` — so every
// string value is checked before it is rendered. The guard had been narrowed to
// `filepath`, which left exactly the single-segment parameters unguarded; for
// the multi-segment `filepath` the check is redundant in practice (`..%2F..`
// stays literal) but keeping it there costs nothing and keeps the rule uniform.
function slashPreservingPathSerializer(args: Parameters<typeof defaultPathSerializer>[0]): string {
  // Numbers, arrays and objects keep the default serialization untouched.
  if (typeof args.value !== 'string') {
    return defaultPathSerializer(args);
  }
  const safeValue = assertSafePathSegments(args.value);
  if (args.name === 'filepath') {
    // The wildcard route matches the rest of the path, so its `/` separators
    // must stay literal and only the segments are encoded.
    return safeValue.split('/').map(encodeURIComponent).join('/');
  }
  return defaultPathSerializer(args);
}

/** Rejects a `.`/`..` path segment, which the URL parser would resolve as navigation. */
function assertSafePathSegments(value: string): string {
  const unsafe = value.split('/').find((segment) => segment === '.' || segment === '..');
  if (unsafe !== undefined) {
    throw new Error(`Unsafe path segment: ${unsafe}`);
  }
  return value;
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
