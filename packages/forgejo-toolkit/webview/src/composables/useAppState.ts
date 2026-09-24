import { ref, reactive, onMounted, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ForgejoInstance } from '../types/instance';

const loading = reactive(new Map<string, boolean>());
const errors = reactive(new Map<string, string>());

// The tracking maps above and some payload maps only ever grow. Cap them:
// once the limit is hit, the oldest entry (Maps iterate in insertion order)
// is evicted. Evicted loading/error entries are harmless — reads default to
// `?? false` / `undefined`.
const MAX_TRACKING_ENTRIES = 500;
const MAX_SEARCH_ENTRIES = 50;
// The host caps a single CI job log at 10 MB but not how many are kept, so a
// session that browses runs in several repositories would hold every log in
// memory (retainContextWhenHidden keeps this state alive for the window).
const MAX_JOB_LOG_ENTRIES = 10;
// Every reactive payload map (repositories, issue bodies, timelines, diffs,
// files, CI jobs, ...) is bounded to this many keys. A key is a repository,
// issue, pull request, path or query and holds a whole page (up to the server's
// 500-row list cap), so the limit is on how many payloads a long session keeps
// alive, not on how big one of them may be. 64 matches the default bound of the
// TTL response caches. `clearRepoPayloads` releases a repository's entries as
// soon as the user navigates to another one, which keeps this bound from being
// the only thing standing between a long session and tens of MB.
const MAX_PAYLOAD_ENTRIES = 64;

// How long a request/response round-trip to the extension host may take
// before the pending promise is rejected as timed out. Most commands answer
// in seconds, so abandoning one after a minute frees its slot instead of
// spinning forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * The host does not bound some commands by the webview's minute: it waits for
 * its own modal confirmation dialog (an unbounded human decision) before
 * replying to the two attachment-delete commands. Rejecting those at 60 s
 * would discard the real reply — and the work the user just confirmed —
 * while the host still considers the request in flight. They get the host's
 * long-operation budget instead (mirrors `API_DOWNLOAD_TIMEOUT_MS` in
 * `src/api/client.ts`, which cannot be imported here: the webview bundle
 * must not pull in extension-host code).
 */
const HOST_LONG_OPERATION_TIMEOUT_MS = 5 * 60_000;

const COMMAND_TIMEOUTS_MS: Record<string, number> = {
  // Host-side native confirmation before the reply.
  deleteReleaseAttachment: HOST_LONG_OPERATION_TIMEOUT_MS,
  deleteIssueCommentAttachment: HOST_LONG_OPERATION_TIMEOUT_MS,
};

function requestTimeoutMs(command: string): number {
  return COMMAND_TIMEOUTS_MS[command] ?? DEFAULT_REQUEST_TIMEOUT_MS;
}

function evictOldestKey<V>(map: Map<string, V>, skip?: (value: V) => boolean) {
  for (const [key, value] of map) {
    if (skip?.(value)) {
      continue;
    }
    map.delete(key);
    return;
  }
}

// Starts a load for `key`: clears any stale error for that key and bounds the
// loading map. Never evicts an in-flight (`true`) entry.
function beginLoading(key: string) {
  errors.delete(key);
  if (!loading.has(key) && loading.size >= MAX_TRACKING_ENTRIES) {
    evictOldestKey(loading, (inFlight) => inFlight);
  }
  loading.set(key, true);
}

function setError(key: string, message: string) {
  if (!errors.has(key) && errors.size >= MAX_TRACKING_ENTRIES) {
    evictOldestKey(errors);
  }
  errors.set(key, message);
}

function setBoundedEntry<V>(map: Map<string, V>, key: string, value: V, maxEntries: number) {
  if (map.has(key)) {
    // Re-insert so a rewritten key becomes the newest: eviction then follows the
    // last write rather than first insertion. Updates never evict a sibling.
    map.delete(key);
  } else if (map.size >= maxEntries) {
    evictOldestKey(map);
  }
  map.set(key, value);
}

/**
 * Drops every entry whose key satisfies `predicate`. One call releases one
 * repository's (or one list's) slots — unlike `clear()`, which would discard
 * every other repository's payload too.
 */
function clearWhere<K, V>(map: Map<K, V>, predicate: (key: K) => boolean) {
  for (const key of [...map.keys()]) {
    if (predicate(key)) {
      map.delete(key);
    }
  }
}

function clearByPrefix<V>(map: Map<string, V>, prefix: string) {
  clearWhere(map, (key) => key.startsWith(prefix));
}

/**
 * Whether a repository-list "fetched" mark written at `timestamp` is still
 * fresh. A mark older than `ttlMs` means the list it guards must be refetched
 * rather than served from the payload map.
 */
function isMarkFresh(timestamp: number | undefined, ttlMs: number): boolean {
  return timestamp !== undefined && Date.now() - timestamp <= ttlMs;
}

/**
 * Whether `key` belongs to the repository scope `${instanceId}:${owner}/${repo}`.
 * Keys append a separator (`:state`, `#pr-3`, `:branch:main`) or nothing at all,
 * so the match must stop at a boundary: clearing `owner/repo` must not also drop
 * a repository called `owner/repository`.
 */
function isInRepoScope(key: string, scope: string): boolean {
  if (!key.startsWith(scope)) {
    return false;
  }
  const next = key[scope.length];
  return next === undefined || next === ':' || next === '#';
}

function clearRepoScope<V>(map: Map<string, V>, scope: string) {
  clearWhere(map, (key) => isInRepoScope(key, scope));
}

/**
 * The part of an instance the webview's cached payloads depend on. The host
 * keeps the id stable across an edit, so comparing these fields is what tells
 * an edit apart from a no-op refresh of the list.
 *
 * The token itself never reaches the webview; the host sends an opaque
 * fingerprint of it instead, which is enough to notice that the credential
 * behind the same URL and account changed.
 */
function instanceCacheIdentity(instance: ForgejoInstance): string {
  return [instance.url, instance.username ?? '', instance.name ?? '', instance.tokenFingerprint ?? ''].join('\u0000');
}

/**
 * Ids whose identity changed between two instance lists (added instances have
 * no cached payloads to release, so only surviving ids are reported).
 */
function changedInstanceIdentities(previous: ForgejoInstance[], next: ForgejoInstance[]): string[] {
  const before = new Map(previous.map((instance) => [instance.id, instanceCacheIdentity(instance)]));
  const changed: string[] = [];
  for (const instance of next) {
    const identity = before.get(instance.id);
    if (identity !== undefined && identity !== instanceCacheIdentity(instance)) {
      changed.push(instance.id);
    }
  }
  return changed;
}
import '../types/config';
import { postMessage } from './vscode';

const vscodeVersion = window.__FORGEJO_TOOLKIT_CONFIG__?.vscodeVersion ?? '';
import { localeTag, type Locale } from '../i18n';
import type {
  ForgejoActionRun,
  ForgejoActionRunJob,
  ForgejoActionArtifact,
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoRepository,
  ForgejoIssue,
  ForgejoUser,
  ForgejoPullRequest,
  ForgejoRepoDetail,
  ForgejoIssueDetail,
  ForgejoIssueAttachment,
  ForgejoPullRequestDetail,
  ForgejoPullRequestWorktreeInfo,
  ForgejoTimelineComment,
  ForgejoPullRequestCommit,
  ForgejoContentEntry,
  ForgejoBranch,
  ForgejoTag,
  ForgejoRelease,
  ForgejoReleaseAttachment,
  GlobalSearchResult,
  ForgejoNotification,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoReaction,
  ForgejoStopWatch,
  ForgejoTrackedTime,
  ForgejoWatchInfo,
} from '../types/api';
import type { GitEntry } from '@cpf23333-forgejo-toolkit/api';

import type {
  ExportSettings,
  HostToWebviewMessage,
  LinkedRepository,
  // Import/export payloads carry the token; the regular instance list never does.
  ForgejoInstance as ExportedForgejoInstance,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { LIST_ITEM_LIMIT } from '@cpf23333-forgejo-toolkit/shared/limits';
import { createTimedCache } from '../utils/createTimedCache';

export interface MentionUser {
  value: string;
  name: string;
  full_name?: string;
  avatar_url?: string;
}

export interface MentionIssue {
  value: string;
  title: string;
  state?: string;
  user?: ForgejoUser;
  is_pull?: boolean;
}

/**
 * Which form a `saveInstanceResult` answers: an existing instance (edit) or a
 * brand-new one (add). The host does not echo identity for this
 * request/response pair, so the webview stamps the reply with the target it
 * sent it for.
 */
export interface SaveInstanceTarget {
  kind: 'instance' | 'new';
  instanceId?: string;
}

export function saveInstanceTargetKey(target: SaveInstanceTarget): string {
  return target.kind === 'instance' ? `instance:${target.instanceId ?? ''}` : 'new';
}

function createAppState() {
  const router = useRouter();
  const { t, locale } = useI18n();

  const instances = ref<ForgejoInstance[]>([]);

  const repositories = ref<Map<string, ForgejoRepository[]>>(new Map());
  const myIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const myPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  const repoDetails = ref<Map<string, ForgejoRepoDetail>>(new Map());
  const issueDetails = ref<Map<string, ForgejoIssueDetail>>(new Map());
  const pullRequestDetails = ref<Map<string, ForgejoPullRequestDetail>>(new Map());
  const repoIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const repoPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  // Runs accumulate per repo (server order) instead of one page replacing the
  // previous one; `actionRunsKey` is the repo's list slot regardless of page.
  const actionRuns = ref<Map<string, ForgejoActionRun[]>>(new Map());
  // Highest page appended so far, per repo. The next page to request comes from
  // this counter rather than from the row count: when the server clamps the
  // page size (`[api] MaxResponseItems`) a row-count estimate re-requests a page
  // that is already loaded and the list never advances.
  const actionRunsPage = ref<Map<string, number>>(new Map());
  // Whether another page of runs may exist for a repo, decided by the server's
  // total (an empty page ends the list too). The view offers "Load more" only
  // while this is true.
  const actionRunsHasMore = ref<Map<string, boolean>>(new Map());
  const actionRunTotalCount = ref<Map<string, number>>(new Map());
  const actionRunDetails = ref<Map<string, ForgejoActionRun>>(new Map());
  const actionRunJobs = ref<Map<string, ForgejoActionRunJob[]>>(new Map());
  const actionRunArtifacts = ref<Map<string, ForgejoActionArtifact[]>>(new Map());
  const actionJobLogs = ref<Map<string, string>>(new Map());
  const repoBranchCommits = ref<Map<string, ForgejoCommit[]>>(new Map());
  const pullRequestFiles = ref<Map<string, ForgejoChangedFile[]>>(new Map());
  const pullRequestComments = ref<Map<string, ForgejoTimelineComment[]>>(new Map());
  const pullRequestCommits = ref<Map<string, ForgejoPullRequestCommit[]>>(new Map());
  const repoContents = ref<Map<string, ForgejoContentEntry[]>>(new Map());
  const repoRefs = ref<Map<string, { branches: ForgejoBranch[]; tags: ForgejoTag[]; releases: ForgejoRelease[] }>>(
    new Map(),
  );
  const repoFileSearchResults = ref<Map<string, GitEntry[]>>(new Map());
  // Per search: the host could not read the whole repository tree, so matches
  // may be missing. Keyed like the results so a new query starts clean.
  const repoFileSearchTruncated = ref<Map<string, boolean>>(new Map());
  const fileHistories = ref<Map<string, ForgejoCommit[]>>(new Map());
  const globalSearchResults = ref<Map<string, GlobalSearchResult>>(new Map());
  const globalSearchActiveScope = ref<'all' | 'repositories' | 'issues' | 'pullRequests'>('all');
  const globalSearchQuery = ref<string>('');
  const notifications = ref<Map<string, ForgejoNotification[]>>(new Map());
  // Cursor for the next "load more" (the oldest notification already shown) and
  // whether another page may exist. The endpoint returns no total, so a full
  // page is the only signal. A cursor rather than a page number: marking
  // notifications read removes them from the filtered server list, which would
  // shift every later offset and silently skip entries.
  const notificationsBefore = ref<Map<string, string>>(new Map());
  const notificationsHasMore = ref<Map<string, boolean>>(new Map());
  const polledNotifications = ref<Map<string, ForgejoNotification[]>>(new Map());
  // Per-instance poll failures (expired token, unreachable instance) so the
  // notifications view can show an error instead of a misleading empty state.
  const notificationPollErrors = ref<Map<string, string>>(new Map());
  const repoLabels = ref<Map<string, ForgejoLabel[]>>(new Map());
  const repoAssignees = ref<Map<string, string[]>>(new Map());
  const repoMilestones = ref<Map<string, ForgejoMilestone[]>>(new Map());
  const issueSubscriptions = ref<Map<string, ForgejoWatchInfo>>(new Map());
  const issueTrackedTimes = ref<Map<string, ForgejoTrackedTime[]>>(new Map());
  const issueDependencies = ref<Map<string, ForgejoIssue[]>>(new Map());
  const issueReactions = ref<Map<string, ForgejoReaction[]>>(new Map());
  const commentReactions = ref<Map<string, ForgejoReaction[]>>(new Map());
  const userStopwatches = ref<Map<string, ForgejoStopWatch[]>>(new Map());

  /**
   * Writes one payload slot with the shared `MAX_PAYLOAD_ENTRIES` bound. Every
   * write into a reactive payload map goes through here: unlike `Map.set` it
   * cannot grow the map past the cap, so a long session cannot accumulate one
   * entry per repository/issue/pull request/query it ever visited.
   */
  function setPayloadEntry<V>(map: Map<string, V>, key: string, value: V) {
    setBoundedEntry(map, key, value, MAX_PAYLOAD_ENTRIES);
  }

  /**
   * Writes one comment's reactions. This map is bounded per repository rather
   * than by the shared `MAX_PAYLOAD_ENTRIES`: a timeline longer than 64 comments
   * would otherwise lose the earliest comments' reactions while their rows are
   * still on screen (the view renders the whole page).
   *
   * The active repository is capped by what a timeline can actually show. The
   * host returns at most `LIST_ITEM_LIMIT` comments, so no more than that many
   * rows of it are ever rendered; anything beyond is off screen and evicted
   * oldest-written first, exactly like `setBoundedEntry`. The entries outside
   * the active repository — rows the user has navigated away from, whose
   * payload `clearRepoPayloads` could not release because the navigation went
   * straight from one repository to another — keep the older one-for-one
   * replacement, which cannot accumulate either. Nothing is dropped while no
   * repository is active: without one there is no evidence that any row has
   * left the screen.
   */
  function setCommentReactionEntry(key: string, value: ForgejoReaction[]) {
    const map = commentReactions.value;
    const active = activeRepoScope;
    if (active !== undefined) {
      // Oldest-written first, so the eviction order is the write order (as in
      // `setBoundedEntry`: a rewrite re-inserts the key).
      const entries = [...map.keys()].map((candidate) => ({
        key: candidate,
        stale: !isInRepoScope(candidate, active),
      }));
      // `key` takes a new slot in exactly one scope — the one it belongs to —
      // and a rewrite of a key already held takes none. The other scope is not
      // touched by this write and must not be charged for it: charging it would
      // evict one of its entries while every row of it is still on screen.
      const writeStale = !isInRepoScope(key, active);
      const limits = [
        { stale: false, cap: LIST_ITEM_LIMIT },
        { stale: true, cap: MAX_PAYLOAD_ENTRIES },
      ];
      for (const limit of limits) {
        const inScope = entries.filter((entry) => entry.stale === limit.stale);
        // Re-inserted at the end of this function, so the written key is never
        // an eviction candidate of its own scope.
        const candidates = inScope.filter((entry) => entry.key !== key);
        const projected = inScope.length + (limit.stale === writeStale && !map.has(key) ? 1 : 0);
        for (let removed = 0; projected - removed > limit.cap; removed += 1) {
          map.delete(candidates[removed].key);
        }
      }
    }
    // Re-insert so a rewritten key becomes the newest, like the bounded maps.
    map.delete(key);
    map.set(key, value);
  }

  const repositoriesCache = createTimedCache<ForgejoRepository[]>(30_000);
  const myIssuesCache = createTimedCache<ForgejoIssue[]>(30_000);
  const myPullRequestsCache = createTimedCache<ForgejoPullRequest[]>(30_000);

  const repoContentsCache = createTimedCache<ForgejoContentEntry[]>(30_000);
  const repoRefsCache = createTimedCache<{ branches: ForgejoBranch[]; tags: ForgejoTag[]; releases: ForgejoRelease[] }>(
    30_000,
  );
  const repoBranchCommitsCache = createTimedCache<ForgejoCommit[]>(30_000);
  const pullRequestFilesCache = createTimedCache<ForgejoChangedFile[]>(30_000);
  const pullRequestCommitsCache = createTimedCache<ForgejoPullRequestCommit[]>(30_000);
  const repoDetailsCache = createTimedCache<ForgejoRepoDetail>(60_000);
  const repoLabelsCache = createTimedCache<ForgejoLabel[]>(60_000);
  const repoAssigneesCache = createTimedCache<string[]>(60_000);
  const repoMilestonesCache = createTimedCache<ForgejoMilestone[]>(60_000);
  // repoIssues/repoPullRequests store the lists themselves; these track when
  // each list was last fetched so a cached list goes stale after the TTL and
  // the next visit refetches instead of serving it forever.
  //
  // A reactive Map rather than a `createTimedCache`, and NOT wrapped in a ref:
  // the dependency picker reads the mark from a `computed`, and a plain object
  // behind a computed caches its first answer forever, so "this list has never
  // been fetched" would never turn into "it has" (and the picker's empty hint
  // could never render). Every value here is a fetch timestamp.
  const REPO_LIST_MARKS_TTL_MS = 30_000;
  const repoIssuesFetchedAt = reactive(new Map<string, number>());
  const repoPullRequestsFetchedAt = reactive(new Map<string, number>());

  const issueDetailCache = createTimedCache<ForgejoIssueDetail>(5_000);
  const pullRequestDetailCache = createTimedCache<ForgejoPullRequestDetail>(5_000);
  const pullRequestCommentsCache = createTimedCache<ForgejoTimelineComment[]>(5_000);
  const renderedMarkdownCache = createTimedCache<string>(30_000, 100);

  let inputRequestId = 0;
  const inputBoxPromises = new Map<string, (value: string | undefined) => void>();
  const confirmPromises = new Map<string, (value: boolean) => void>();
  const releaseAttachmentPromises = new Map<
    string,
    { resolve: (value: ForgejoReleaseAttachment) => void; reject: (error: string) => void }
  >();
  // Resolves `true` when the attachment was actually deleted and `false` when
  // the user declined the host-side confirmation, so callers only drop the
  // attachment from local state when the server really removed it.
  const releaseAttachmentDeletePromises = new Map<
    string,
    { resolve: (deleted: boolean) => void; reject: (error: string) => void }
  >();

  const debug = ref<boolean>(false);
  const worktrees = ref<ForgejoPullRequestWorktreeInfo[]>([]);
  const worktreeOpenMode = ref<'ask' | 'currentWindow' | 'newWindow'>('ask');
  const worktreeCacheDirectory = ref<string | undefined>(undefined);
  const worktreeCacheDirectoryDefault = ref<string | undefined>(undefined);
  const supportsMultiDiff = computed(() => isVersionAtLeast(vscodeVersion, '1.86.0'));
  const dashboardActiveTab = ref<'repositories' | 'issues' | 'pullRequests'>('repositories');
  const linkedRepository = ref<LinkedRepository | undefined>(undefined);
  // Every workspace repository linked to a configured instance (multi-root
  // and nested repositories included); linkedRepository is the subset member
  // the host attributed to the current editor context.
  const linkedRepositories = ref<LinkedRepository[]>([]);
  // Manual pick in the dashboard linked-repository card; sticks while the
  // picked repository stays linked, editor attribution drives the card again
  // once it is cleared.
  const selectedLinkedRepoPath = ref<string | undefined>(undefined);
  const activeLinkedRepository = computed(
    () =>
      linkedRepositories.value.find((entry) => entry.localPath === selectedLinkedRepoPath.value) ??
      linkedRepository.value,
  );
  const pendingCreatePr = ref<{ instanceId: string; owner: string; repo: string; head: string } | null>(null);
  const pendingNewIssue = ref<{
    instanceId: string;
    owner: string;
    repo: string;
    title?: string;
    body?: string;
  } | null>(null);
  // `target` is stamped by the webview (the host reply carries no identity):
  // it tells a view which form a `testConnectionResult` answers, so testing one
  // instance and then opening another does not show "Connected as <the other
  // instance's user>" as the form on screen's status. Optional so a reply that
  // arrives without a recorded intent still flows through unchanged.
  const testConnectionResult = ref<
    { success: boolean; username?: string; error?: string; target?: SaveInstanceTarget } | undefined
  >(undefined);
  // `target` is stamped by the webview (the host reply carries no identity):
  // it tells a view which form this reply answers so a reply for one form is
  // not applied to another the user has since opened. Optional so a reply that
  // arrives without a recorded intent still flows through unchanged.
  const saveInstanceResult = ref<{ success: boolean; error?: string; target?: SaveInstanceTarget } | undefined>(
    undefined,
  );
  const exportInstancesResult = ref<{ success: boolean; path?: string; error?: string } | undefined>(undefined);
  const importInstancesResult = ref<{ success: boolean; count?: number; error?: string } | undefined>(undefined);
  // Preview data from the host: token fields are stripped to '' host-side
  // (conflict flags travel in `tokenConflicts`); confirmation goes back as
  // ids only (see confirmImportInstances). `error` is set when the host could
  // not read the file (corrupt JSON, wrong password, no valid instances): the
  // preview is then empty and the views must show the failure instead of an
  // empty-list success state.
  const importPreview = ref<
    | {
        instances: ExportedForgejoInstance[];
        existingIds: string[];
        tokenConflicts?: boolean[];
        settings?: ExportSettings;
        error?: string;
      }
    | undefined
  >(undefined);
  // The host does not echo request ids for these single-slot request/response
  // pairs. To keep rapid consecutive operations from landing out of order,
  // only one request per slot is in flight at a time: while one is pending,
  // a new call only records the latest intent (bumping the token); when the
  // response lands it is compared against the latest token, dropped if
  // superseded, and the latest intent is sent instead.
  let testConnectionToken = 0;
  let testConnectionInFlightToken = 0;
  let testConnectionLatestArgs: { url: string; token: string; instanceId?: string } | undefined;
  let saveInstanceToken = 0;
  let saveInstanceInFlightToken = 0;
  type SaveInstanceMessage =
    | { command: 'saveInstance'; url: string; token: string; syncApiUrlsToInstanceUrl?: boolean }
    | { command: 'editInstance'; id: string; url: string; token: string; syncApiUrlsToInstanceUrl?: boolean };
  let saveInstanceLatestArgs: SaveInstanceMessage | undefined;

  // The form the latest save intent belongs to. The host's reply carries no
  // identity, so every reply is stamped with this target; reading it at reply
  // time also gives a replayed superseded intent its own target once its
  // response finally lands.
  function saveInstanceTargetOf(message: SaveInstanceMessage | undefined): SaveInstanceTarget | undefined {
    if (!message) {
      return undefined;
    }
    return message.command === 'editInstance' ? { kind: 'instance', instanceId: message.id } : { kind: 'new' };
  }

  // The form a `testConnection` intent belongs to: the edit form of the
  // instance it carries, or the add form when it has none. Read at reply time
  // so a replayed superseded intent is stamped with its own target.
  function testConnectionTargetOf(
    message: { url: string; token: string; instanceId?: string } | undefined,
  ): SaveInstanceTarget | undefined {
    if (!message) {
      return undefined;
    }
    return message.instanceId ? { kind: 'instance', instanceId: message.instanceId } : { kind: 'new' };
  }
  let importPreviewToken = 0;
  let importPreviewInFlightToken = 0;
  // Latest loadNotifications intent recorded while a request is in flight;
  // replayed once the in-flight response lands (subjectType is a server-side
  // filter, so the in-flight response may not match the current filters).
  const pendingNotificationIntents = new Map<string, { statusTypes: string[]; subjectType?: string[] }>();
  const inFlightNotificationArgs = new Map<string, string>();
  const lastSavedIssue = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(undefined);
  const lastSavedPullRequest = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(
    undefined,
  );
  const lastWorktreeCancelled = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(
    undefined,
  );
  const lastWorktreeError = ref<
    | {
        error: string;
        operation?: 'open' | 'remove';
        instanceId?: string;
        owner?: string;
        repo?: string;
        index?: number;
      }
    | undefined
  >(undefined);
  // Dispatch key (`dispatchWorkflowKey`) of the most recent "run workflow"
  // request the user declined in the host-side confirmation. The dispatch
  // loading key goes true→false with no error in that case, so without this
  // signal the actions view reads the transition as a successful dispatch and
  // waits for a run that will never appear.
  const lastDispatchCancelled = ref<string | undefined>(undefined);
  let renderMarkdownRequestId = 0;
  const pendingRenderMarkdownRequests = new Map<
    string,
    { resolve: (html: string) => void; reject: (error: Error) => void; cacheKey: string }
  >();
  // In-flight renderMarkdown requests by cacheKey. Components often mount
  // together and ask for the same markdown before the first response lands;
  // they share this promise instead of each sending a duplicate request.
  const inFlightRenderMarkdown = new Map<string, Promise<string>>();
  let attachmentUploadRequestId = 0;
  const pendingAttachmentUploads = new Map<
    string,
    { resolve: (attachment: ForgejoIssueAttachment) => void; reject: (error: Error) => void }
  >();
  let attachmentDeleteRequestId = 0;
  const pendingAttachmentDeletes = new Map<
    string,
    { resolve: (deleted: boolean) => void; reject: (error: Error) => void }
  >();
  let issueCommentCreationRequestId = 0;
  const pendingIssueCommentCreations = new Map<
    string,
    { resolve: (comment: ForgejoTimelineComment) => void; reject: (error: Error) => void }
  >();
  let issueCreationRequestId = 0;
  const pendingIssueCreations = new Map<
    string,
    { resolve: (issue: ForgejoIssue) => void; reject: (error: Error) => void }
  >();
  let pullRequestCreationRequestId = 0;
  const pendingPullRequestCreations = new Map<
    string,
    { resolve: (pr: ForgejoPullRequest) => void; reject: (error: Error) => void }
  >();
  let releaseCreationRequestId = 0;
  const pendingReleaseCreations = new Map<
    string,
    { resolve: (release: ForgejoRelease) => void; reject: (error: Error) => void }
  >();
  let mentionSearchRequestId = 0;
  const pendingMentionSearchRequests = new Map<
    string,
    { resolve: (result: { users: MentionUser[]; issues: MentionIssue[] }) => void; reject: (error: Error) => void }
  >();
  let userPreviewRequestId = 0;
  const pendingUserPreviewRequests = new Map<
    string,
    { resolve: (user: ForgejoUser | undefined) => void; reject: (error: Error) => void }
  >();
  let issuePreviewRequestId = 0;
  const pendingIssuePreviewRequests = new Map<
    string,
    { resolve: (issue: ForgejoIssue | undefined) => void; reject: (error: Error) => void }
  >();

  interface PendingHandlers<T, E> {
    resolve: (value: T) => void;
    reject: (error: E) => void;
  }

  // Registers a pending host request with a timeout. If the host never
  // replies (e.g. the handler bailed out early without answering), the
  // promise rejects and the associated loading state is cleared instead of
  // spinning forever. The stored resolve/reject clear the timer, so normal
  // responses never trigger the timeout path.
  // `command` (the host command name, not the request id) selects the timeout
  // budget: most commands get the default minute, while commands the host may
  // block on a human decision get its long-operation budget.
  function registerPending<T, E>(
    map: Map<string, PendingHandlers<T, E> & { loadingKey?: string }>,
    id: string,
    command: string,
    handlers: PendingHandlers<T, E>,
    options?: { loadingKey?: string; makeTimeoutError?: () => E; extra?: Record<string, unknown> },
  ): void {
    const { loadingKey } = options ?? {};
    const makeTimeoutError = options?.makeTimeoutError ?? (() => new Error(t('common.requestTimeout')) as E);
    const timer = setTimeout(() => {
      if (!map.delete(id)) {
        return;
      }
      if (loadingKey) {
        loading.set(loadingKey, false);
        setError(loadingKey, t('common.requestTimeout'));
      }
      handlers.reject(makeTimeoutError());
    }, requestTimeoutMs(command));
    map.set(id, {
      ...options?.extra,
      resolve: (value: T) => {
        clearTimeout(timer);
        handlers.resolve(value);
      },
      reject: (error: E) => {
        clearTimeout(timer);
        handlers.reject(error);
      },
      ...(loadingKey ? { loadingKey } : {}),
    });
  }

  // Rejects a pending request when the host sends a generic `requestError`
  // fallback reply (the handler finished or threw without answering).
  function rejectPendingRequest(requestId: string, error: string): boolean {
    const errorMaps: Array<Map<string, { reject: (error: Error) => void; loadingKey?: string }>> = [
      pendingIssueCreations,
      pendingIssueCommentCreations,
      pendingPullRequestCreations,
      pendingReleaseCreations,
      pendingAttachmentUploads,
      pendingAttachmentDeletes,
      pendingMentionSearchRequests,
      pendingUserPreviewRequests,
      pendingIssuePreviewRequests,
      pendingRenderMarkdownRequests,
    ];
    for (const map of errorMaps) {
      const pending = map.get(requestId);
      if (!pending) {
        continue;
      }
      map.delete(requestId);
      if (pending.loadingKey) {
        loading.set(pending.loadingKey, false);
        setError(pending.loadingKey, error);
      }
      pending.reject(new Error(error));
      return true;
    }
    const stringMaps: Array<Map<string, { reject: (error: string) => void; loadingKey?: string }>> = [
      releaseAttachmentPromises,
      releaseAttachmentDeletePromises,
    ];
    for (const map of stringMaps) {
      const pending = map.get(requestId);
      if (!pending) {
        continue;
      }
      map.delete(requestId);
      pending.reject(error);
      return true;
    }
    return false;
  }

  function handleMessage(event: MessageEvent<HostToWebviewMessage>) {
    const message = event.data;
    switch (message.command) {
      case 'initialState':
        instances.value = message.instances ?? [];
        locale.value = message.locale;
        debug.value = message.debug;
        worktrees.value = (message.worktrees ?? []) as ForgejoPullRequestWorktreeInfo[];
        worktreeOpenMode.value = message.worktreeOpenMode;
        worktreeCacheDirectory.value = message.worktreeCacheDirectory;
        worktreeCacheDirectoryDefault.value = message.worktreeCacheDirectoryDefault;
        loadLinkedRepository();
        break;
      case 'linkedRepository': {
        const payload = message as { linked?: LinkedRepository; all?: LinkedRepository[] };
        linkedRepository.value = payload.linked;
        linkedRepositories.value = payload.all ?? (payload.linked ? [payload.linked] : []);
        // A manual selection is only meaningful while its repository is
        // still linked; otherwise fall back to host attribution.
        if (
          selectedLinkedRepoPath.value &&
          !linkedRepositories.value.some((entry) => entry.localPath === selectedLinkedRepoPath.value)
        ) {
          selectedLinkedRepoPath.value = undefined;
        }
        break;
      }
      case 'instances': {
        const next = message.data ?? [];
        // An instance keeps its id across an edit, so a URL or account change
        // leaves every payload cached under that id describing the *previous*
        // server/account. Drop them before the new list lands (see
        // clearInstancePayloads).
        const changed = changedInstanceIdentities(instances.value, next);
        instances.value = next;
        for (const instanceId of changed) {
          clearInstancePayloads(instanceId);
        }
        break;
      }
      case 'refreshData':
        refreshInstanceData();
        break;
      case 'requestError': {
        const { _requestId, error } = message as { _requestId?: unknown; error?: unknown };
        if (typeof _requestId === 'string') {
          rejectPendingRequest(_requestId, typeof error === 'string' ? error : t('common.requestFailed'));
        }
        break;
      }
      case 'openSettings':
        router.push({ name: 'settings' });
        break;
      case 'openDashboard':
        router.push({ name: 'dashboard' });
        break;
      case 'openNotifications':
        router.push({ name: 'notifications' });
        break;
      case 'openCreatePullRequest': {
        const { instanceId, owner, repo, head } = message;
        pendingCreatePr.value = { instanceId, owner, repo, head };
        router.push({ name: 'repoPullRequests', params: { instanceId, owner, repo, state: 'open' } });
        break;
      }
      case 'openNewIssue': {
        const { instanceId, owner, repo, title, body } = message;
        pendingNewIssue.value = { instanceId, owner, repo, title, body };
        router.push({ name: 'repoIssues', params: { instanceId, owner, repo, state: 'open' } });
        break;
      }
      case 'openPullRequestDetail':
        openPullRequestDetail(message.instanceId, message.owner, message.repo, message.index);
        break;
      case 'setLocale':
        locale.value = message.locale;
        break;
      case 'setDebug':
        debug.value = message.debug;
        break;
      case 'repositories':
        handleRepositories(message as { instanceId: string; repositories?: ForgejoRepository[]; error?: string });
        break;
      case 'myIssues':
        handleMyIssues(message as { instanceId: string; state?: string; issues?: ForgejoIssue[]; error?: string });
        break;
      case 'myPullRequests':
        handleMyPullRequests(
          message as { instanceId: string; state?: string; pullRequests?: ForgejoPullRequest[]; error?: string },
        );
        break;
      case 'repoDetail':
        handleRepoDetail(
          message as { instanceId: string; owner: string; repo: string; detail?: ForgejoRepoDetail; error?: string },
        );
        break;
      case 'repoBranchCommits':
        handleRepoBranchCommits(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            branch: string;
            commits?: ForgejoCommit[];
            error?: string;
          },
        );
        break;
      case 'issueDetail':
        handleIssueDetail(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            detail?: ForgejoIssueDetail;
            error?: string;
          },
        );
        break;
      case 'repoLabels':
        handleRepoLabels(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            labels?: ForgejoLabel[];
            error?: string;
          },
        );
        break;
      case 'repoAssignees':
        handleRepoAssignees(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            assignees?: string[];
            error?: string;
          },
        );
        break;
      case 'repoMilestones':
        handleRepoMilestones(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            milestones?: ForgejoMilestone[];
            error?: string;
          },
        );
        break;
      case 'issueSubscriptionChecked':
        handleIssueSubscriptionChecked(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            subscribed?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueSubscriptionChanged':
        handleIssueSubscriptionChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            subscribed?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueStopwatchChanged':
        handleIssueStopwatchChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            action: 'start' | 'stop' | 'delete';
            error?: string;
          },
        );
        break;
      case 'userStopwatches':
        handleUserStopwatches(
          message as {
            instanceId: string;
            stopwatches?: ForgejoStopWatch[];
            error?: string;
          },
        );
        break;
      case 'issueTrackedTimes':
        handleIssueTrackedTimes(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            times?: ForgejoTrackedTime[];
            error?: string;
          },
        );
        break;
      case 'issueTimeAdded':
        handleIssueTimeAdded(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            time?: ForgejoTrackedTime;
            error?: string;
          },
        );
        break;
      case 'issueTimeReset':
        handleIssueTimeReset(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            cancelled?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueTimeDeleted':
        handleIssueTimeDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            id: number;
            cancelled?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueDependencies':
        handleIssueDependencies(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            dependencies?: ForgejoIssue[];
            error?: string;
          },
        );
        break;
      case 'issueDependencyChanged':
        handleIssueDependencyChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            dependencyIndex: number;
            action: 'add' | 'remove';
            error?: string;
          },
        );
        break;
      case 'issueReactions':
        handleIssueReactions(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            reactions?: ForgejoReaction[];
            error?: string;
          },
        );
        break;
      case 'issueReactionChanged':
        handleIssueReactionChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            content: string;
            action: 'add' | 'remove';
            error?: string;
          },
        );
        break;
      case 'commentReactions':
        handleCommentReactions(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            reactions?: ForgejoReaction[];
            error?: string;
          },
        );
        break;
      case 'commentReactionChanged':
        handleCommentReactionChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            content: string;
            action: 'add' | 'remove';
            error?: string;
          },
        );
        break;
      case 'mentionSearchResult':
        handleMentionSearchResult(
          message as { _requestId: string; users?: unknown[]; issues?: unknown[]; error?: string },
        );
        break;
      case 'userPreviewResult':
        handleUserPreviewResult(message as { _requestId: string; user?: unknown; error?: string });
        break;
      case 'issuePreviewResult':
        handleIssuePreviewResult(message as { _requestId: string; issue?: unknown; error?: string });
        break;
      case 'pullRequestDetail':
        handlePullRequestDetail(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            detail?: ForgejoPullRequestDetail;
            error?: string;
          },
        );
        break;
      case 'issueCreated':
      case 'issueUpdated':
        handleIssueSaved(
          message.command,
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            item?: ForgejoIssue;
            error?: string;
          },
        );
        break;
      case 'issueDeleted':
        handleIssueDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            error?: string;
          },
        );
        break;
      case 'issueCommentCreated':
        handleIssueCommentCreated(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            comment?: ForgejoTimelineComment;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'issueCommentEdited':
        handleIssueCommentEdited(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            comment?: ForgejoTimelineComment;
            error?: string;
          },
        );
        break;
      case 'issueCommentAttachmentCreated':
        handleIssueCommentAttachmentCreated(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            commentId: number;
            id?: number;
            uuid?: string;
            name?: string;
            size?: number;
            browser_download_url?: string;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'issueCommentDeleted':
        handleIssueCommentDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            error?: string;
          },
        );
        break;
      case 'issueCommentAttachmentDeleted':
        handleIssueCommentAttachmentDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            attachmentId: number;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'pullRequestReviewSubmitted':
        handlePullRequestReviewSubmitted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
          },
        );
        break;
      case 'pullRequestMerged':
        handlePullRequestMerged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            error?: string;
          },
        );
        break;
      case 'revertMergeCommitResult':
        handleRevertMergeCommitResult(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            success?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueAttachmentCreated':
        handleIssueAttachmentCreated(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            // The server id of the new attachment. It is what the delete path
            // needs (`deleteIssueAttachment` takes a numeric id), so it must be
            // kept from the upload reply.
            id?: number;
            uuid?: string;
            name?: string;
            size?: number;
            browser_download_url?: string;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'issueAttachmentDeleted':
        handleIssueAttachmentDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            attachmentId: number;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'pullRequestCreated':
      case 'pullRequestUpdated':
        handlePullRequestSaved(
          message.command,
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            item?: ForgejoPullRequest;
            error?: string;
          },
        );
        break;
      case 'pullRequestFiles':
        handlePullRequestFiles(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            files?: ForgejoChangedFile[];
            error?: string;
          },
        );
        break;
      case 'pullRequestCommentsAndTimeline':
        handlePullRequestCommentsAndTimeline(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            comments?: ForgejoTimelineComment[];
            error?: string;
          },
        );
        break;
      case 'pullRequestCommits':
        handlePullRequestCommits(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            commits?: ForgejoPullRequestCommit[];
            error?: string;
          },
        );
        break;
      case 'repoIssues':
        handleRepoIssues(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            state: string;
            issues?: ForgejoIssue[];
            error?: string;
          },
        );
        break;
      case 'repoPullRequests':
        handleRepoPullRequests(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            state: string;
            pullRequests?: ForgejoPullRequest[];
            error?: string;
          },
        );
        break;
      case 'actionRuns':
        handleActionRuns(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            page: number;
            actionRuns?: ForgejoActionRun[];
            totalCount?: number;
            error?: string;
          },
        );
        break;
      case 'actionRun':
        handleActionRun(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            runId: number;
            run?: ForgejoActionRun;
            error?: string;
          },
        );
        break;
      case 'actionRunJobs':
        handleActionRunJobs(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            runId: number;
            jobs?: ForgejoActionRunJob[];
            error?: string;
          },
        );
        break;
      case 'actionRunArtifacts':
        handleActionRunArtifacts(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            runId: number;
            artifacts?: ForgejoActionArtifact[];
            error?: string;
          },
        );
        break;
      case 'actionJobLog':
        handleActionJobLog(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            jobId: number;
            log?: string;
            error?: string;
          },
        );
        break;
      case 'actionRunDispatched':
        handleActionRunDispatched(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            workflowfilename: string;
            accepted?: boolean;
            run?: unknown;
            error?: string;
          },
        );
        break;
      case 'actionRunCancelled':
        handleActionRunCancelled(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            runId: number;
            success?: boolean;
            error?: string;
          },
        );
        break;
      case 'actionRunDeleted':
        handleActionRunDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            runId: number;
            success?: boolean;
            error?: string;
          },
        );
        break;
      case 'actionArtifactDownloaded':
        handleActionArtifactDownloaded(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            artifactId: number;
            path?: string;
            cancelled?: boolean;
            error?: string;
          },
        );
        break;
      case 'renderedMarkdown':
        handleRenderedMarkdown(message as { _requestId: string; html?: string; error?: string });
        break;
      case 'repoContents':
        handleRepoContents(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            ref: string;
            path: string;
            entries?: ForgejoContentEntry[];
            error?: string;
          },
        );
        break;
      case 'repoFilesSearchResult':
        handleRepoFilesSearchResult(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            ref: string;
            query: string;
            files?: GitEntry[];
            error?: string;
          },
        );
        break;
      case 'globalSearchResult':
        handleGlobalSearchResult(
          message as {
            instanceId: string;
            scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
            query: string;
            state: string;
            repositories?: ForgejoRepository[];
            issues?: ForgejoIssue[];
            pullRequests?: ForgejoPullRequest[];
            error?: string;
          },
        );
        break;
      case 'notifications':
        handleNotifications(message as { instanceId: string; notifications?: ForgejoNotification[]; error?: string });
        break;
      case 'polledNotifications': {
        // Poller pushes go to a dedicated slot so they never clobber the
        // user's filtered view; the unread badge reads from this slot.
        const data = message as { instanceId: string; notifications?: ForgejoNotification[]; error?: string };
        if (data.error) {
          setPayloadEntry(notificationPollErrors.value, data.instanceId, data.error);
        } else {
          notificationPollErrors.value.delete(data.instanceId);
          const polled = data.notifications ?? [];
          setPayloadEntry(polledNotifications.value, data.instanceId, polled);
          // The poller asks the server for the unread list, so its result is
          // authoritative for *which* notifications are unread — not only for
          // the badge the slot feeds. Reconciling the view's slot against it
          // keeps an open Notifications view from contradicting the badge (its
          // rows are written exclusively by getNotifications replies, so a
          // "Mark all as read" from the host toast left them unread).
          reconcileViewNotifications(data.instanceId, polled);
        }
        break;
      }
      case 'notificationMarkedRead':
        handleNotificationMarkedRead(message as { instanceId: string; id: number; error?: string });
        break;
      case 'allNotificationsMarkedRead':
        handleAllNotificationsMarkedRead(message as { instanceId: string; error?: string });
        break;
      case 'fileHistory':
        handleFileHistory(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            path: string;
            ref: string;
            commits?: ForgejoCommit[];
            error?: string;
          },
        );
        break;
      case 'repoRefs':
        handleRepoRefs(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            branches?: ForgejoBranch[];
            tags?: ForgejoTag[];
            releases?: ForgejoRelease[];
            error?: string;
          },
        );
        break;
      case 'repoBranchCreated':
      case 'repoBranchDeleted':
      case 'repoTagCreated':
      case 'repoTagDeleted':
      case 'repoReleaseEdited':
      case 'repoReleaseDeleted': {
        const { instanceId, owner, repo, cancelled, error } = message as {
          instanceId: string;
          owner: string;
          repo: string;
          cancelled?: boolean;
          error?: string;
        };
        if (cancelled) {
          // The user declined the host-side confirmation: nothing was deleted.
          break;
        }
        const key = repoRefsKey(instanceId, owner, repo);
        if (error) {
          setError(key, error);
        } else {
          errors.delete(key);
          loadRepoRefs(instanceId, owner, repo, true);
        }
        break;
      }
      case 'repoReleaseCreated': {
        const { instanceId, owner, repo, item, error, _requestId } = message as {
          instanceId: string;
          owner: string;
          repo: string;
          item?: unknown;
          error?: string;
          _requestId: string;
        };
        const pending = pendingReleaseCreations.get(_requestId);
        if (pending) {
          pendingReleaseCreations.delete(_requestId);
          if (error || !item) {
            pending.reject(new Error(error || t('common.releaseCreationFailed')));
          } else {
            pending.resolve(item as ForgejoRelease);
          }
        }
        const key = repoRefsKey(instanceId, owner, repo);
        loading.set(key, false);
        if (error) {
          setError(key, error);
        } else {
          errors.delete(key);
          loadRepoRefs(instanceId, owner, repo, true);
        }
        break;
      }
      case 'showInputBoxResult': {
        const { id, value } = message as { id: string; value?: string };
        const resolve = inputBoxPromises.get(id);
        if (resolve) {
          inputBoxPromises.delete(id);
          resolve(value);
        }
        break;
      }
      case 'releaseAttachmentCreated': {
        const { _requestId, attachment, error } = message as {
          _requestId: string;
          attachment?: ForgejoReleaseAttachment;
          error?: string;
        };
        const pending = releaseAttachmentPromises.get(_requestId);
        if (pending) {
          releaseAttachmentPromises.delete(_requestId);
          if (error || !attachment) {
            pending.reject(error || t('common.attachmentUploadFailed'));
          } else {
            pending.resolve(attachment);
          }
        }
        break;
      }
      case 'releaseAttachmentDeleted': {
        const { _requestId, error, cancelled } = message as {
          _requestId: string;
          error?: string;
          cancelled?: boolean;
        };
        const pending = releaseAttachmentDeletePromises.get(_requestId);
        if (pending) {
          releaseAttachmentDeletePromises.delete(_requestId);
          if (error) {
            pending.reject(error);
          } else {
            pending.resolve(!cancelled);
          }
        }
        break;
      }
      case 'showConfirmResult': {
        const { id, confirmed } = message as { id: string; confirmed: boolean };
        const resolve = confirmPromises.get(id);
        if (resolve) {
          confirmPromises.delete(id);
          resolve(confirmed);
        }
        break;
      }
      case 'worktreesList':
        worktrees.value = (message.worktrees ?? []) as ForgejoPullRequestWorktreeInfo[];
        break;
      case 'worktreeOpened':
        if (message.worktree) {
          const wt = message.worktree as ForgejoPullRequestWorktreeInfo;
          const list = worktrees.value.filter((w) => w.id !== wt.id);
          list.push(wt);
          worktrees.value = list;
        }
        break;
      case 'worktreeRemoved':
        if (message.id) {
          worktrees.value = worktrees.value.filter((w) => w.id !== message.id);
        }
        break;
      case 'worktreeCancelled':
        lastWorktreeCancelled.value = {
          instanceId: message.instanceId,
          owner: message.owner,
          repo: message.repo,
          index: message.index,
        };
        break;
      case 'worktreeError':
        lastWorktreeError.value = {
          error: message.error,
          operation: message.operation,
          instanceId: message.instanceId,
          owner: message.owner,
          repo: message.repo,
          index: message.index,
        };
        break;
      case 'worktreeOpenMode':
        if (message.mode === 'ask' || message.mode === 'currentWindow' || message.mode === 'newWindow') {
          worktreeOpenMode.value = message.mode;
        }
        break;
      case 'startWorkResult': {
        const key = startWorkKey(message.instanceId, message.owner, message.repo, message.index);
        loading.set(key, false);
        if (message.error) {
          setError(key, message.error);
        } else {
          errors.delete(key);
          // A created worktree must reach the Settings list, which renders
          // `worktrees`. The host reply is a bare success flag today, so the
          // worktree (when the host starts sending it, see the note in
          // registerStartWorkWorktree) is merged exactly like `worktreeOpened`.
          const created = (message as { worktree?: unknown }).worktree;
          if (created) {
            registerStartWorkWorktree(created as ForgejoPullRequestWorktreeInfo);
          }
        }
        break;
      }
      case 'worktreeCacheDirectory':
        worktreeCacheDirectory.value = message.directory;
        worktreeCacheDirectoryDefault.value = message.defaultDirectory;
        break;
      case 'testConnectionResult':
        handleTestConnectionResult(message);
        break;
      case 'saveInstanceResult':
        handleSaveInstanceResult(message);
        break;
      case 'instancesExported':
        // A cancel (dismissed dialog or password prompt) is not a result: storing
        // it would make Settings report "Failed to export instances".
        if (!(message as { cancelled?: boolean }).cancelled) {
          exportInstancesResult.value = message;
        }
        break;
      case 'instancesImported':
        // A cancel (dismissed file picker or password prompt) is not a result:
        // storing it would make every view report a failed import. Leave the
        // state untouched so the views stay quiet.
        if (!(message as { cancelled?: boolean }).cancelled) {
          importInstancesResult.value = message;
        }
        break;
      case 'importInstancesPreview': {
        if (importPreviewInFlightToken !== importPreviewToken) {
          importPreviewInFlightToken = importPreviewToken;
          postMessage({ command: 'previewImportInstances' });
          break;
        }
        importPreviewInFlightToken = 0;
        if ((message as { cancelled?: boolean }).cancelled) {
          // The user dismissed the file picker; free the slot without navigating.
          break;
        }
        const previewMessage = message as {
          instances?: ExportedForgejoInstance[];
          existingIds?: string[];
          tokenConflicts?: boolean[];
          settings?: ExportSettings;
          error?: string;
        };
        importPreview.value = {
          instances: previewMessage.instances ?? [],
          existingIds: previewMessage.existingIds ?? [],
          tokenConflicts: previewMessage.tokenConflicts ?? [],
          settings: previewMessage.settings,
          // A failed read arrives with empty arrays; keep the error so the
          // preview view can explain the failure instead of looking empty.
          error: previewMessage.error,
        };
        break;
      }
    }
  }

  function handleRepositories(data: { instanceId: string; repositories?: ForgejoRepository[]; error?: string }) {
    const key = `repos-${data.instanceId}`;
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.repositories ?? [];
      setPayloadEntry(repositories.value, data.instanceId, list);
      repositoriesCache.set(data.instanceId, list);
    }
  }

  function handleMyIssues(data: { instanceId: string; state?: string; issues?: ForgejoIssue[]; error?: string }) {
    // The host echoes the requested state; fall back to the default only for
    // replies from a host build that predates the echo.
    const state = data.state ?? 'open';
    const key = `issues-${data.instanceId}-${state}`;
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.issues ?? [];
      setPayloadEntry(myIssues.value, data.instanceId, list);
      myIssuesCache.set(`${data.instanceId}:${state}`, list);
    }
  }

  function handleMyPullRequests(data: {
    instanceId: string;
    state?: string;
    pullRequests?: ForgejoPullRequest[];
    error?: string;
  }) {
    const state = data.state ?? 'open';
    const key = `pulls-${data.instanceId}-${state}`;
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.pullRequests ?? [];
      setPayloadEntry(myPullRequests.value, data.instanceId, list);
      myPullRequestsCache.set(`${data.instanceId}:${state}`, list);
    }
  }

  function handleRepoDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    detail?: ForgejoRepoDetail;
    error?: string;
  }) {
    const key = repoDetailKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else if (data.detail) {
      errors.delete(key);
      setPayloadEntry(repoDetails.value, key, data.detail);
      repoDetailsCache.set(key, data.detail);
    }
  }

  function handleRepoBranchCommits(data: {
    instanceId: string;
    owner: string;
    repo: string;
    branch: string;
    commits?: ForgejoCommit[];
    error?: string;
  }) {
    const key = repoBranchCommitsKey(data.instanceId, data.owner, data.repo, data.branch);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.commits ?? [];
      setPayloadEntry(repoBranchCommits.value, key, list);
      repoBranchCommitsCache.set(key, list);
    }
  }

  function handleIssueDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    detail?: ForgejoIssueDetail;
    error?: string;
  }) {
    const key = issueDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else if (data.detail) {
      errors.delete(key);
      setPayloadEntry(issueDetails.value, key, data.detail);
      issueDetailCache.set(key, data.detail);
    }
  }

  function handleRepoLabels(data: {
    instanceId: string;
    owner: string;
    repo: string;
    labels?: ForgejoLabel[];
    error?: string;
  }) {
    const key = repoLabelsKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.labels ?? [];
      setPayloadEntry(repoLabels.value, key, list);
      repoLabelsCache.set(key, list);
    }
  }

  function handleRepoAssignees(data: {
    instanceId: string;
    owner: string;
    repo: string;
    assignees?: string[];
    error?: string;
  }) {
    const key = repoAssigneesKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.assignees ?? [];
      setPayloadEntry(repoAssignees.value, key, list);
      repoAssigneesCache.set(key, list);
    }
  }

  function handleRepoMilestones(data: {
    instanceId: string;
    owner: string;
    repo: string;
    milestones?: ForgejoMilestone[];
    error?: string;
  }) {
    const key = repoMilestonesKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.milestones ?? [];
      setPayloadEntry(repoMilestones.value, key, list);
      repoMilestonesCache.set(key, list);
    }
  }

  function handleIssueSubscriptionChecked(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    subscribed?: boolean;
    error?: string;
  }) {
    const key = issueSubscriptionKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(issueSubscriptions.value, key, { subscribed: data.subscribed });
    }
  }

  function handleIssueSubscriptionChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    subscribed?: boolean;
    error?: string;
  }) {
    const key = issueSubscriptionKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(issueSubscriptions.value, key, { subscribed: data.subscribed });
      loadIssueSubscription(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleIssueStopwatchChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    action: 'start' | 'stop' | 'delete';
    cancelled?: boolean;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.cancelled) {
      // Declined host-side confirmation: nothing changed, so keep the current
      // tracked-time / stopwatch state untouched.
      errors.delete(key);
      return;
    }
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      loadIssueTrackedTimes(data.instanceId, data.owner, data.repo, data.index, true);
      loadUserStopwatches(data.instanceId, true);
    }
  }

  function handleUserStopwatches(data: { instanceId: string; stopwatches?: ForgejoStopWatch[]; error?: string }) {
    const key = userStopwatchesKey(data.instanceId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(userStopwatches.value, key, data.stopwatches ?? []);
    }
  }

  function handleIssueTrackedTimes(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    times?: ForgejoTrackedTime[];
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(issueTrackedTimes.value, key, data.times ?? []);
    }
  }

  function handleIssueTimeAdded(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    time?: ForgejoTrackedTime;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      loadIssueTrackedTimes(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleIssueTimeReset(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was reset, so the
      // shown tracked times must stay as they are (the success branch below
      // would empty the list and report it as reset).
      return;
    }
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(issueTrackedTimes.value, key, []);
    }
  }

  function handleIssueTimeDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    id: number;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was deleted.
      return;
    }
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = issueTrackedTimes.value.get(key) ?? [];
      setPayloadEntry(
        issueTrackedTimes.value,
        key,
        list.filter((t) => t.id !== data.id),
      );
    }
  }

  function handleIssueDependencies(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    dependencies?: ForgejoIssue[];
    error?: string;
  }) {
    const key = issueDependenciesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(issueDependencies.value, key, data.dependencies ?? []);
    }
  }

  function handleIssueDependencyChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    dependencyIndex: number;
    action: 'add' | 'remove';
    cancelled?: boolean;
    error?: string;
  }) {
    const key = issueDependenciesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was changed.
      return;
    }
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      loadIssueDependencies(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleIssueReactions(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    reactions?: ForgejoReaction[];
    error?: string;
  }) {
    const key = issueReactionsKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(issueReactions.value, key, data.reactions ?? []);
    }
  }

  function handleIssueReactionChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    content: string;
    action: 'add' | 'remove';
    error?: string;
  }) {
    const key = issueReactionsKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      loadIssueReactions(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleCommentReactions(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    reactions?: ForgejoReaction[];
    error?: string;
  }) {
    const key = commentReactionsKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(key, false);
    // Free the in-flight slot first, whichever way the request ended.
    releaseReactionRequestSlot();
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setCommentReactionEntry(key, data.reactions ?? []);
    }
  }

  function handleCommentReactionChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: string;
    action: 'add' | 'remove';
    error?: string;
  }) {
    const key = commentReactionsKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      loadCommentReactions(data.instanceId, data.owner, data.repo, data.commentId, true);
    }
  }

  function handleMentionSearchResult(data: {
    _requestId: string;
    users?: unknown[];
    issues?: unknown[];
    error?: string;
  }) {
    const pending = pendingMentionSearchRequests.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingMentionSearchRequests.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve({
        users: (data.users ?? []) as MentionUser[],
        issues: (data.issues ?? []) as MentionIssue[],
      });
    }
  }

  function handleUserPreviewResult(data: { _requestId: string; user?: unknown; error?: string }) {
    const pending = pendingUserPreviewRequests.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingUserPreviewRequests.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(data.user as ForgejoUser | undefined);
    }
  }

  function handleIssuePreviewResult(data: { _requestId: string; issue?: unknown; error?: string }) {
    const pending = pendingIssuePreviewRequests.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingIssuePreviewRequests.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(data.issue as ForgejoIssue | undefined);
    }
  }

  function handlePullRequestDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    detail?: ForgejoPullRequestDetail;
    error?: string;
  }) {
    const key = pullRequestDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else if (data.detail) {
      errors.delete(key);
      setPayloadEntry(pullRequestDetails.value, key, data.detail);
      pullRequestDetailCache.set(key, data.detail);
    }
  }

  function handleIssueAttachmentCreated(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    id?: number;
    uuid?: string;
    name?: string;
    size?: number;
    browser_download_url?: string;
    error?: string;
    _requestId: string;
  }) {
    const pending = pendingAttachmentUploads.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingAttachmentUploads.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else if (data.uuid) {
      pending.resolve({
        id: data.id,
        uuid: data.uuid,
        name: data.name ?? data.uuid,
        size: data.size,
        browser_download_url: data.browser_download_url ?? `/attachments/${data.uuid}`,
      });
    } else {
      pending.reject(new Error(t('common.attachmentUploadFailed')));
    }
  }

  function handleIssueAttachmentDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    attachmentId: number;
    cancelled?: boolean;
    error?: string;
    _requestId: string;
  }) {
    const pending = pendingAttachmentDeletes.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingAttachmentDeletes.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve(!data.cancelled);
    }
  }

  function handleIssueSaved(
    command: 'issueCreated' | 'issueUpdated',
    data: {
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: ForgejoIssue;
      error?: string;
      _requestId?: string;
      stateToggle?: boolean;
      dueDateUpdate?: boolean;
    },
  ) {
    // A close/reopen toggle or an inline due-date save reports against its own
    // key so the error surfaces next to the control that started it, not
    // inside the (possibly closed) edit form.
    const formKey = data.stateToggle
      ? issueStateKey(data.instanceId, data.owner, data.repo, data.index)
      : data.dueDateUpdate
        ? issueDueDateKey(data.instanceId, data.owner, data.repo, data.index)
        : issueFormKey(data.instanceId, data.owner, data.repo, command === 'issueUpdated' ? data.index : 0);
    loading.set(formKey, false);
    if (command === 'issueCreated' && data._requestId) {
      const pending = pendingIssueCreations.get(data._requestId);
      if (pending) {
        pendingIssueCreations.delete(data._requestId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else if (data.item) {
          pending.resolve(data.item);
        } else {
          pending.reject(new Error(t('common.issueCreationFailed')));
        }
      }
    }
    if (data.error) {
      setError(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.item) {
      // Scope the invalidation to the repository that changed: clearing every
      // list would drop other repositories' payloads and, because it skipped the
      // fresh-mark cleanup, the next visit would serve them as fresh for 30 s.
      invalidateRepoIssueLists(repoScopePrefix(data.instanceId, data.owner, data.repo));
      myIssues.value.clear();
      myIssuesCache.clear();
      lastSavedIssue.value = { instanceId: data.instanceId, owner: data.owner, repo: data.repo, index: data.index };
    }
  }

  function handleIssueDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = issueDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was deleted.
      return;
    }
    if (data.error) {
      setError(key, data.error);
      return;
    }
    errors.delete(key);
    issueDetails.value.delete(key);
    // Same repository-scoped invalidation as a save: only this repository's
    // lists are stale, and their fresh marks must go with them.
    invalidateRepoIssueLists(repoScopePrefix(data.instanceId, data.owner, data.repo));
    myIssues.value.clear();
    myIssuesCache.clear();
    // Only navigate back if the user is still viewing the deleted issue;
    // a late response must not hijack a later navigation.
    const current = router.currentRoute.value;
    if (
      current.name === 'issueDetail' &&
      String(current.params.instanceId) === data.instanceId &&
      String(current.params.owner) === data.owner &&
      String(current.params.repo) === data.repo &&
      String(current.params.index) === String(data.index)
    ) {
      router.go(-1);
    }
  }

  function handleIssueCommentCreated(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    comment?: ForgejoTimelineComment;
    error?: string;
    _requestId: string;
  }) {
    const formKey = issueCommentFormKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(formKey, false);
    const pending = pendingIssueCommentCreations.get(data._requestId);
    if (pending) {
      pendingIssueCommentCreations.delete(data._requestId);
      if (data.error) {
        pending.reject(new Error(data.error));
      } else if (data.comment) {
        pending.resolve(data.comment);
      } else {
        pending.reject(new Error(t('common.commentCreationFailed')));
      }
    }
    if (data.error) {
      setError(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.comment) {
      const commentsKey = pullRequestCommentsKey(data.instanceId, data.owner, data.repo, data.index);
      const existing = pullRequestComments.value.get(commentsKey) ?? [];
      const timelineComment: ForgejoTimelineComment = { ...data.comment, type: 'comment' };
      setPayloadEntry(pullRequestComments.value, commentsKey, [...existing, timelineComment]);
    }
  }

  function handleIssueCommentEdited(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    comment?: ForgejoTimelineComment;
    error?: string;
  }) {
    const formKey = issueCommentEditFormKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(formKey, false);
    if (data.error) {
      setError(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (!data.comment) {
      return;
    }
    const scopedPrefix = `${data.instanceId}:${data.owner}/${data.repo}`;
    for (const key of pullRequestComments.value.keys()) {
      if (!key.startsWith(scopedPrefix)) {
        continue;
      }
      const comments = pullRequestComments.value.get(key);
      if (!comments) {
        continue;
      }
      const index = comments.findIndex((c) => c.id === data.commentId);
      if (index !== -1) {
        comments[index] = { ...data.comment, type: 'comment', assets: comments[index].assets };
        setPayloadEntry(pullRequestComments.value, key, [...comments]);
        break;
      }
    }
  }

  function handleIssueCommentAttachmentCreated(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    commentId: number;
    id?: number;
    uuid?: string;
    name?: string;
    size?: number;
    browser_download_url?: string;
    error?: string;
    _requestId: string;
  }) {
    const promise = pendingAttachmentUploads.get(data._requestId);
    if (!promise) {
      return;
    }
    if (data.error) {
      promise.reject(new Error(data.error));
      pendingAttachmentUploads.delete(data._requestId);
      return;
    }
    const attachment: ForgejoIssueAttachment = {
      id: data.id,
      uuid: data.uuid ?? '',
      name: data.name ?? '',
      size: data.size,
      browser_download_url: data.browser_download_url ?? '',
    };
    promise.resolve(attachment);
    pendingAttachmentUploads.delete(data._requestId);

    const commentsKey = pullRequestCommentsKey(data.instanceId, data.owner, data.repo, data.index);
    const comments = pullRequestComments.value.get(commentsKey);
    if (!comments) {
      return;
    }
    const updatedComments = comments.map((comment) => {
      if (comment.id !== data.commentId) {
        return comment;
      }
      return { ...comment, assets: [...(comment.assets ?? []), attachment] };
    });
    setPayloadEntry(pullRequestComments.value, commentsKey, updatedComments);
  }

  function handleIssueCommentAttachmentDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    attachmentId: number;
    cancelled?: boolean;
    error?: string;
    _requestId: string;
  }) {
    const promise = pendingAttachmentDeletes.get(data._requestId);
    if (!promise) {
      return;
    }
    if (data.error) {
      promise.reject(new Error(data.error));
      pendingAttachmentDeletes.delete(data._requestId);
      return;
    }
    promise.resolve(!data.cancelled);
    pendingAttachmentDeletes.delete(data._requestId);

    if (data.cancelled) {
      // Declined host-side confirmation: the attachment still exists, so local
      // state must not drop it.
      return;
    }

    const scopedPrefix = `${data.instanceId}:${data.owner}/${data.repo}`;
    for (const [key, comments] of pullRequestComments.value.entries()) {
      if (!key.startsWith(scopedPrefix)) {
        continue;
      }
      const comment = comments.find((c) => c.id === data.commentId);
      if (comment && comment.assets) {
        comment.assets = comment.assets.filter((a) => a.id !== data.attachmentId);
      }
    }
  }

  function handleIssueCommentDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    cancelled?: boolean;
    error?: string;
  }) {
    const formKey = issueCommentDeleteFormKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(formKey, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was deleted.
      return;
    }
    if (data.error) {
      setError(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    const scopedPrefix = `${data.instanceId}:${data.owner}/${data.repo}`;
    for (const [key, comments] of pullRequestComments.value.entries()) {
      if (!key.startsWith(scopedPrefix)) {
        continue;
      }
      const index = comments.findIndex((c) => c.id === data.commentId);
      if (index !== -1) {
        comments.splice(index, 1);
        setPayloadEntry(pullRequestComments.value, key, [...comments]);
        break;
      }
    }
  }

  function handlePullRequestReviewSubmitted(data: { instanceId: string; owner: string; repo: string; index: number }) {
    const detailKey = pullRequestDetailKey(data.instanceId, data.owner, data.repo, data.index);
    // Only reload when the detail is currently loaded (i.e. someone is viewing
    // it); otherwise the forced refetch would be wasted traffic.
    if (!pullRequestDetails.value.has(detailKey)) {
      return;
    }
    loadPullRequestDetail(data.instanceId, data.owner, data.repo, data.index, true);
    loadPullRequestComments(data.instanceId, data.owner, data.repo, data.index, true);
  }

  function handlePullRequestMerged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    cancelled?: boolean;
    error?: string;
  }) {
    const formKey = pullRequestMergeFormKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(formKey, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was merged.
      return;
    }
    if (data.error) {
      setError(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    const detailKey = pullRequestDetailKey(data.instanceId, data.owner, data.repo, data.index);
    const detail = pullRequestDetails.value.get(detailKey);
    if (detail) {
      detail.state = 'closed';
      detail.merged = true;
    }
    invalidateRepoPullRequestLists(repoScopePrefix(data.instanceId, data.owner, data.repo));
    myPullRequests.value.clear();
    myPullRequestsCache.clear();
  }

  function handleRevertMergeCommitResult(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    success?: boolean;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = `revert-merge:${data.instanceId}:${data.owner}/${data.repo}#${data.index}`;
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was reverted.
      return;
    }
    if (data.error) {
      setError(key, data.error);
      return;
    }
    errors.delete(key);
    loadPullRequestDetail(data.instanceId, data.owner, data.repo, data.index, true);
    loadPullRequestComments(data.instanceId, data.owner, data.repo, data.index, true);
    loadPullRequestCommits(data.instanceId, data.owner, data.repo, data.index, true);
    loadPullRequestFiles(data.instanceId, data.owner, data.repo, data.index, undefined, undefined, true);
  }

  function handlePullRequestSaved(
    command: 'pullRequestCreated' | 'pullRequestUpdated',
    data: {
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: ForgejoPullRequest;
      error?: string;
      _requestId?: string;
      stateToggle?: boolean;
      dueDateUpdate?: boolean;
    },
  ) {
    // Same split as handleIssueSaved: close/reopen toggles and inline due-date
    // saves use their own keys.
    const formKey = data.stateToggle
      ? pullRequestStateKey(data.instanceId, data.owner, data.repo, data.index)
      : data.dueDateUpdate
        ? pullRequestDueDateKey(data.instanceId, data.owner, data.repo, data.index)
        : pullRequestFormKey(data.instanceId, data.owner, data.repo, command === 'pullRequestUpdated' ? data.index : 0);
    loading.set(formKey, false);
    if (command === 'pullRequestCreated' && data._requestId) {
      const pending = pendingPullRequestCreations.get(data._requestId);
      if (pending) {
        pendingPullRequestCreations.delete(data._requestId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else if (data.item) {
          pending.resolve(data.item);
        } else {
          pending.reject(new Error(t('common.pullRequestCreationFailed')));
        }
      }
    }
    if (data.error) {
      setError(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.item) {
      // Repository-scoped, like handleIssueSaved: only this repository's pull
      // request lists (and their fresh marks) changed.
      invalidateRepoPullRequestLists(repoScopePrefix(data.instanceId, data.owner, data.repo));
      myPullRequests.value.clear();
      myPullRequestsCache.clear();
      lastSavedPullRequest.value = {
        instanceId: data.instanceId,
        owner: data.owner,
        repo: data.repo,
        index: data.index,
      };
    }
  }

  function handlePullRequestFiles(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    baseSha?: string;
    headSha?: string;
    files?: ForgejoChangedFile[];
    error?: string;
  }) {
    // The host echoes baseSha/headSha back, so the response lands under the
    // exact key its request used.
    const key = pullRequestFilesKey(data.instanceId, data.owner, data.repo, data.index, data.baseSha, data.headSha);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.files ?? [];
      setPayloadEntry(pullRequestFiles.value, key, list);
      pullRequestFilesCache.set(key, list);
    }
  }

  function handlePullRequestCommentsAndTimeline(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    comments?: ForgejoTimelineComment[];
    error?: string;
  }) {
    const key = pullRequestCommentsKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.comments ?? [];
      setPayloadEntry(pullRequestComments.value, key, list);
      pullRequestCommentsCache.set(key, list);
    }
  }

  function handlePullRequestCommits(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    commits?: ForgejoPullRequestCommit[];
    error?: string;
  }) {
    const key = pullRequestCommitsKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.commits ?? [];
      setPayloadEntry(pullRequestCommits.value, key, list);
      pullRequestCommitsCache.set(key, list);
    }
  }

  function handleRepoIssues(data: {
    instanceId: string;
    owner: string;
    repo: string;
    state: string;
    query?: string;
    issues?: ForgejoIssue[];
    error?: string;
  }) {
    const key = repoIssuesKey(data.instanceId, data.owner, data.repo, data.state, data.query);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(repoIssues.value, key, data.issues ?? []);
      repoIssuesFetchedAt.set(key, Date.now());
    }
  }

  function handleRepoPullRequests(data: {
    instanceId: string;
    owner: string;
    repo: string;
    state: string;
    query?: string;
    pullRequests?: ForgejoPullRequest[];
    error?: string;
  }) {
    const key = repoPullRequestsKey(data.instanceId, data.owner, data.repo, data.state, data.query);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(repoPullRequests.value, key, data.pullRequests ?? []);
      repoPullRequestsFetchedAt.set(key, Date.now());
    }
  }

  function handleActionRuns(data: {
    instanceId: string;
    owner: string;
    repo: string;
    page: number;
    actionRuns?: ForgejoActionRun[];
    totalCount?: number;
    error?: string;
  }) {
    // One list slot per repo: pages are appended in server order instead of
    // overwriting each other, so "Load more" can never replace the runs the
    // user already sees.
    const key = actionRunsKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
      return;
    }
    errors.delete(key);
    const incoming = data.actionRuns ?? [];
    const page = data.page > 0 ? data.page : 1;
    const loadedPage = actionRunsPage.value.get(key) ?? 0;
    // Explicit end of the list: the server returned nothing for the page that
    // directly follows the loaded ones.
    let ended = false;
    if (page === 1) {
      // The first page starts the list over: a refresh/retry resets whatever
      // earlier pages had accumulated.
      setPayloadEntry(actionRuns.value, key, incoming);
      setPayloadEntry(actionRunsPage.value, key, 1);
    } else if (page === loadedPage + 1) {
      if (incoming.length > 0) {
        setPayloadEntry(actionRuns.value, key, [...(actionRuns.value.get(key) ?? []), ...incoming]);
        setPayloadEntry(actionRunsPage.value, key, page);
      } else {
        // A page past the end ends the list even if the server total disagrees
        // (stale or filtered count), and stops "Load more" from re-requesting it.
        ended = true;
        setPayloadEntry(actionRunsPage.value, key, page);
      }
    } else {
      // A late or duplicated reply for a page that no longer follows the
      // loaded ones (e.g. after a refresh): drop its rows instead of
      // duplicating or skipping entries.
    }
    const totalKey = `${data.instanceId}:${data.owner}/${data.repo}`;
    if (typeof data.totalCount === 'number') {
      setPayloadEntry(actionRunTotalCount.value, totalKey, data.totalCount);
    } else if (page === 1) {
      // Host builds that predate the total: seed it from the first page.
      setPayloadEntry(actionRunTotalCount.value, totalKey, incoming.length);
    }
    // The total is exact, so it decides whether more runs exist; without one,
    // fall back to asking whether the requested page was filled.
    const loadedCount = actionRuns.value.get(key)?.length ?? 0;
    setPayloadEntry(
      actionRunsHasMore.value,
      key,
      !ended &&
        (typeof data.totalCount === 'number'
          ? loadedCount < data.totalCount
          : incoming.length >= ACTION_RUNS_PAGE_LIMIT),
    );
  }

  function handleActionRun(data: {
    instanceId: string;
    owner: string;
    repo: string;
    runId: number;
    run?: ForgejoActionRun;
    error?: string;
  }) {
    const key = actionRunKey(data.instanceId, data.owner, data.repo, data.runId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else if (data.run) {
      errors.delete(key);
      setPayloadEntry(actionRunDetails.value, key, data.run);
    }
  }

  function handleActionRunJobs(data: {
    instanceId: string;
    owner: string;
    repo: string;
    runId: number;
    jobs?: ForgejoActionRunJob[];
    error?: string;
  }) {
    const key = actionRunJobsKey(data.instanceId, data.owner, data.repo, data.runId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(actionRunJobs.value, key, data.jobs ?? []);
    }
  }

  function handleActionRunArtifacts(data: {
    instanceId: string;
    owner: string;
    repo: string;
    runId: number;
    artifacts?: ForgejoActionArtifact[];
    error?: string;
  }) {
    const key = actionRunArtifactsKey(data.instanceId, data.owner, data.repo, data.runId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(actionRunArtifacts.value, key, data.artifacts ?? []);
    }
  }

  function handleActionJobLog(data: {
    instanceId: string;
    owner: string;
    repo: string;
    jobId: number;
    log?: string;
    error?: string;
  }) {
    const key = actionJobLogKey(data.instanceId, data.owner, data.repo, data.jobId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      // A log is by far the heaviest payload, so it gets its own, much smaller
      // bound (see MAX_JOB_LOG_ENTRIES).
      setBoundedEntry(actionJobLogs.value, key, data.log ?? '', MAX_JOB_LOG_ENTRIES);
    }
  }

  function handleActionRunDispatched(data: {
    instanceId: string;
    owner: string;
    repo: string;
    workflowfilename: string;
    accepted?: boolean;
    run?: unknown;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = dispatchWorkflowKey(data.instanceId, data.owner, data.repo, data.workflowfilename);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was dispatched, so
      // the view must not treat the cleared loading state as success.
      lastDispatchCancelled.value = key;
      return;
    }
    // Any other reply ends the slot: a later dispatch must not be mistaken for
    // this one still being declined.
    lastDispatchCancelled.value = undefined;
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      if (data.run && typeof data.run === 'object' && (data.run as { id?: number }).id) {
        const run = data.run as { id: number };
        loadActionRun(data.instanceId, data.owner, data.repo, run.id, true);
        loadActionRunJobs(data.instanceId, data.owner, data.repo, run.id, true);
      }
      loadActionRuns(data.instanceId, data.owner, data.repo, 1, true);
    }
  }

  function handleActionRunCancelled(data: {
    instanceId: string;
    owner: string;
    repo: string;
    runId: number;
    success?: boolean;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = actionRunCancelKey(data.instanceId, data.owner, data.repo, data.runId);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: the run was not cancelled.
      return;
    }
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      loadActionRun(data.instanceId, data.owner, data.repo, data.runId, true);
      loadActionRunJobs(data.instanceId, data.owner, data.repo, data.runId, true);
      loadActionRuns(data.instanceId, data.owner, data.repo, 1, true);
    }
  }

  function handleActionRunDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    runId: number;
    success?: boolean;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = actionRunDeleteKey(data.instanceId, data.owner, data.repo, data.runId);
    loading.set(key, false);
    if (data.cancelled) {
      // The user declined the host-side confirmation: nothing was deleted.
      return;
    }
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      // Collect the run's job ids before dropping the jobs entry so their
      // (potentially large) log strings can be evicted too.
      const jobsKey = actionRunJobsKey(data.instanceId, data.owner, data.repo, data.runId);
      const runJobs = actionRunJobs.value.get(jobsKey) ?? [];
      actionRunDetails.value.delete(actionRunKey(data.instanceId, data.owner, data.repo, data.runId));
      actionRunJobs.value.delete(jobsKey);
      actionRunArtifacts.value.delete(actionRunArtifactsKey(data.instanceId, data.owner, data.repo, data.runId));
      for (const job of runJobs) {
        if (job.id !== undefined) {
          actionJobLogs.value.delete(actionJobLogKey(data.instanceId, data.owner, data.repo, job.id));
        }
      }
      // Drop only this repo's list state: deleting one run must not wipe the
      // accumulated pages of every other repo. The list reloads when the view
      // becomes active again.
      const listKey = actionRunsKey(data.instanceId, data.owner, data.repo);
      actionRuns.value.delete(listKey);
      actionRunsPage.value.delete(listKey);
      actionRunsHasMore.value.delete(listKey);
      actionRunTotalCount.value.delete(`${data.instanceId}:${data.owner}/${data.repo}`);
      // There is no standalone "actions" route (actions live inside RepoDetail),
      // so return to the repo detail page. Only navigate if the user is still
      // viewing the deleted run; a late response must not hijack a later navigation.
      const current = router.currentRoute.value;
      if (
        current.name === 'actionRunDetail' &&
        String(current.params.instanceId) === data.instanceId &&
        String(current.params.owner) === data.owner &&
        String(current.params.repo) === data.repo &&
        String(current.params.runId) === String(data.runId)
      ) {
        router.push({
          name: 'repoDetail',
          params: { instanceId: data.instanceId, owner: data.owner, repo: data.repo },
        });
      }
    }
  }

  function handleActionArtifactDownloaded(data: {
    instanceId: string;
    owner: string;
    repo: string;
    artifactId: number;
    path?: string;
    cancelled?: boolean;
    error?: string;
  }) {
    const key = actionArtifactDownloadKey(data.instanceId, data.owner, data.repo, data.artifactId);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
    }
  }

  function handleRepoContents(data: {
    instanceId: string;
    owner: string;
    repo: string;
    ref: string;
    path: string;
    entries?: ForgejoContentEntry[];
    error?: string;
  }) {
    const key = repoContentsKey(data.instanceId, data.owner, data.repo, data.ref, data.path);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const list = data.entries ?? [];
      setPayloadEntry(repoContents.value, key, list);
      repoContentsCache.set(key, list);
    }
  }

  function handleRepoFilesSearchResult(data: {
    instanceId: string;
    owner: string;
    repo: string;
    ref: string;
    query: string;
    files?: GitEntry[];
    truncated?: boolean;
    error?: string;
  }) {
    const key = repoFileSearchKey(data.instanceId, data.owner, data.repo, data.ref, data.query);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
      repoFileSearchTruncated.value.delete(key);
    } else {
      errors.delete(key);
      setBoundedEntry(repoFileSearchResults.value, key, data.files ?? [], MAX_SEARCH_ENTRIES);
      // The host reports an incomplete repository tree; the view says the
      // results may be missing matches instead of showing them as exhaustive.
      setBoundedEntry(repoFileSearchTruncated.value, key, data.truncated === true, MAX_SEARCH_ENTRIES);
    }
  }

  function handleGlobalSearchResult(data: {
    instanceId: string;
    scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
    query: string;
    state: string;
    repositories?: ForgejoRepository[];
    issues?: ForgejoIssue[];
    pullRequests?: ForgejoPullRequest[];
    error?: string;
  }) {
    const key = globalSearchKey(data.instanceId, data.scope, data.query, data.state);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
      return;
    }
    errors.delete(key);
    const existing = globalSearchResults.value.get(key) ?? {
      repositories: [],
      issues: [],
      pullRequests: [],
    };
    setBoundedEntry(
      globalSearchResults.value,
      key,
      {
        repositories: data.repositories ?? existing.repositories,
        issues: data.issues ?? existing.issues,
        pullRequests: data.pullRequests ?? existing.pullRequests,
      },
      MAX_SEARCH_ENTRIES,
    );
  }

  function handleNotifications(data: {
    instanceId: string;
    notifications?: ForgejoNotification[];
    before?: string;
    error?: string;
  }) {
    const key = notificationsKey(data.instanceId);
    loading.set(key, false);
    // Replay the latest intent if filters changed while this request was in
    // flight (subjectType is filtered server-side, so the response that just
    // landed may not match the current filters). The stale response must not
    // be written into the view slot — the replayed request will land shortly.
    const pending = pendingNotificationIntents.get(data.instanceId);
    pendingNotificationIntents.delete(data.instanceId);
    const inFlightArgs = inFlightNotificationArgs.get(data.instanceId);
    inFlightNotificationArgs.delete(data.instanceId);
    if (pending && JSON.stringify(pending) !== inFlightArgs) {
      loadNotifications(data.instanceId, pending.statusTypes, pending.subjectType);
      return;
    }
    if (data.error) {
      setError(key, data.error);
      return;
    }
    errors.delete(key);
    const incoming = data.notifications ?? [];
    // A reply that echoes a cursor answers a "load more" request: append to
    // what is shown. Without one it is a fresh list and replaces it.
    const isMore = typeof data.before === 'string' && data.before.length > 0;
    const merged = isMore ? mergeNotificationPages(notifications.value.get(key) ?? [], incoming) : incoming;
    setPayloadEntry(notifications.value, key, merged);
    // A list without a usable timestamp has no cursor: "load more" stays off
    // rather than requesting an unbounded page.
    const cursor = oldestNotificationTimestamp(merged);
    if (cursor === undefined) {
      notificationsBefore.value.delete(key);
    } else {
      setPayloadEntry(notificationsBefore.value, key, cursor);
    }
    // Only an empty page proves the end. A short page does not: the server may
    // clamp the page size below NOTIFICATIONS_LIMIT, and the endpoint reports its
    // total in a response header the generated client does not expose. A short
    // page therefore keeps "load more" available, and the page after it (empty)
    // turns the button off — one extra request instead of silently hiding
    // notifications.
    setPayloadEntry(notificationsHasMore.value, key, incoming.length > 0);
  }

  /**
   * Align the view's notification slot with the unread set the poller just
   * fetched. The poller asks for `['unread', 'pinned']`, so an id missing from
   * `polled` is read on the server; marking it read locally is what keeps an
   * open Notifications view consistent with the badge after a "Mark all as
   * read" (the host's toast path never writes the view slot). The view's rows
   * themselves are untouched: only the `unread` flag moves.
   */
  function reconcileViewNotifications(instanceId: string, polled: ForgejoNotification[]) {
    const key = notificationsKey(instanceId);
    const list = notifications.value.get(key);
    if (!list || list.length === 0) {
      return;
    }
    const unreadIds = new Set(
      polled.filter((notification) => notification.unread).map((notification) => notification.id),
    );
    let changed = false;
    const reconciled = list.map((notification) => {
      const unread = notification.id !== undefined && unreadIds.has(notification.id);
      if (unread === notification.unread) {
        return notification;
      }
      changed = true;
      return { ...notification, unread };
    });
    if (changed) {
      setPayloadEntry(notifications.value, key, reconciled);
    }
  }

  function handleNotificationMarkedRead(data: { instanceId: string; id: number; error?: string }) {
    const key = notificationsKey(data.instanceId);
    if (data.error) {
      setError(key, data.error);
      return;
    }
    // A later success clears an earlier failure, the way handleNotifications does.
    errors.delete(key);
    const list = notifications.value.get(key) ?? [];
    setPayloadEntry(
      notifications.value,
      key,
      list.map((notification) => (notification.id === data.id ? { ...notification, unread: false } : notification)),
    );
    // Keep the badge slot in sync so the count drops before the next poll.
    const polled = polledNotifications.value.get(data.instanceId) ?? [];
    setPayloadEntry(
      polledNotifications.value,
      data.instanceId,
      polled.map((notification) => (notification.id === data.id ? { ...notification, unread: false } : notification)),
    );
  }

  function handleAllNotificationsMarkedRead(data: { instanceId: string; error?: string }) {
    const key = notificationsKey(data.instanceId);
    if (data.error) {
      setError(key, data.error);
      return;
    }
    // A later success clears an earlier failure, the way handleNotifications does.
    errors.delete(key);
    const list = notifications.value.get(key) ?? [];
    setPayloadEntry(
      notifications.value,
      key,
      list.map((notification) => ({ ...notification, unread: false })),
    );
    const polled = polledNotifications.value.get(data.instanceId) ?? [];
    setPayloadEntry(
      polledNotifications.value,
      data.instanceId,
      polled.map((notification) => ({ ...notification, unread: false })),
    );
  }

  function handleFileHistory(data: {
    instanceId: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
    commits?: ForgejoCommit[];
    error?: string;
  }) {
    const key = fileHistoryKey(data.instanceId, data.owner, data.repo, data.path, data.ref);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      setPayloadEntry(fileHistories.value, key, data.commits ?? []);
    }
  }

  function handleRepoRefs(data: {
    instanceId: string;
    owner: string;
    repo: string;
    branches?: ForgejoBranch[];
    tags?: ForgejoTag[];
    releases?: ForgejoRelease[];
    error?: string;
  }) {
    const key = repoRefsKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      setError(key, data.error);
    } else {
      errors.delete(key);
      const value = {
        branches: data.branches ?? [],
        tags: data.tags ?? [],
        releases: data.releases ?? [],
      };
      setPayloadEntry(repoRefs.value, key, value);
      repoRefsCache.set(key, value);
    }
  }

  function handleRenderedMarkdown(data: { _requestId: string; html?: string; error?: string }) {
    const pending = pendingRenderMarkdownRequests.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingRenderMarkdownRequests.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      const html = data.html ?? '';
      renderedMarkdownCache.set(pending.cacheKey, html);
      pending.resolve(html);
    }
  }

  onMounted(() => {
    window.addEventListener('message', handleMessage);
    postMessage({ command: 'getInitialState' });
  });

  function openExternal(url: string) {
    postMessage({ command: 'openExternal', url });
  }

  function openWorktreePath(path: string) {
    postMessage({ command: 'openWorktreePath', path });
  }

  function copyToClipboard(text: string) {
    postMessage({ command: 'copyToClipboard', text });
  }

  // The instance id travels with the request: the host keys the preview
  // document by it, so without it every instance's README would share one
  // document and a second instance's preview would overwrite the first's.
  function previewReadme(instanceId: string, owner: string, repo: string, content: string) {
    postMessage({ command: 'previewReadme', instanceId, owner, repo, content });
  }

  // The single-slot request/response pairs (testConnection, saveInstance)
  // carry no request id, so the host's dispatch fallback cannot answer them
  // when a handler bails out early or throws. Arm a timeout per send: if no
  // response lands in time, a synthetic timeout response runs through the
  // same handler, freeing the slot (and replaying a superseded intent).
  let testConnectionTimeout: ReturnType<typeof setTimeout> | undefined;
  let saveInstanceTimeout: ReturnType<typeof setTimeout> | undefined;

  function handleTestConnectionResult(message: { success: boolean; username?: string; error?: string }) {
    if (testConnectionTimeout !== undefined) {
      clearTimeout(testConnectionTimeout);
      testConnectionTimeout = undefined;
    }
    if (testConnectionInFlightToken !== testConnectionToken && testConnectionLatestArgs) {
      // This response answers a superseded request; drop it and send the
      // latest intent instead (the host does not echo request ids).
      testConnectionInFlightToken = testConnectionToken;
      postMessage({ command: 'testConnection', ...testConnectionLatestArgs });
      armTestConnectionTimeout();
      return;
    }
    testConnectionInFlightToken = 0;
    // Stamp the reply with the form the intent it answers was sent for, the
    // same way a save reply is stamped: without it, testing one instance and
    // then opening another leaves "Connected as <the first user>" on the form
    // now on screen.
    testConnectionResult.value = { ...message, target: testConnectionTargetOf(testConnectionLatestArgs) };
  }

  function armTestConnectionTimeout() {
    if (testConnectionTimeout !== undefined) {
      clearTimeout(testConnectionTimeout);
    }
    testConnectionTimeout = setTimeout(() => {
      handleTestConnectionResult({ success: false, error: t('common.requestTimeout') });
    }, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  function handleSaveInstanceResult(message: { success: boolean; error?: string }) {
    if (saveInstanceTimeout !== undefined) {
      clearTimeout(saveInstanceTimeout);
      saveInstanceTimeout = undefined;
    }
    if (saveInstanceInFlightToken !== saveInstanceToken && saveInstanceLatestArgs) {
      saveInstanceInFlightToken = saveInstanceToken;
      postMessage(saveInstanceLatestArgs);
      armSaveInstanceTimeout();
      return;
    }
    saveInstanceInFlightToken = 0;
    // Stamp the reply with the target of the intent it answers (the latest
    // one: a superseded response was dropped and replayed above, and the
    // target is read from the args that request was sent with).
    saveInstanceResult.value = { ...message, target: saveInstanceTargetOf(saveInstanceLatestArgs) };
  }

  function armSaveInstanceTimeout() {
    if (saveInstanceTimeout !== undefined) {
      clearTimeout(saveInstanceTimeout);
    }
    saveInstanceTimeout = setTimeout(() => {
      handleSaveInstanceResult({ success: false, error: t('common.requestTimeout') });
    }, DEFAULT_REQUEST_TIMEOUT_MS);
  }

  function testConnection(url: string, token: string, instanceId?: string) {
    testConnectionToken += 1;
    testConnectionLatestArgs = { url, token, instanceId };
    if (testConnectionInFlightToken !== 0) {
      return;
    }
    testConnectionInFlightToken = testConnectionToken;
    postMessage({ command: 'testConnection', url, token, instanceId });
    armTestConnectionTimeout();
  }

  function saveInstance(url: string, token: string, syncApiUrlsToInstanceUrl?: boolean) {
    sendSaveInstance({ command: 'saveInstance', url, token, syncApiUrlsToInstanceUrl });
  }

  function editInstance(id: string, url: string, token: string, syncApiUrlsToInstanceUrl?: boolean) {
    sendSaveInstance({ command: 'editInstance', id, url, token, syncApiUrlsToInstanceUrl });
  }

  function sendSaveInstance(message: SaveInstanceMessage) {
    saveInstanceToken += 1;
    saveInstanceLatestArgs = message;
    if (saveInstanceInFlightToken !== 0) {
      return;
    }
    saveInstanceInFlightToken = saveInstanceToken;
    postMessage(message);
    armSaveInstanceTimeout();
  }

  function removeInstance(id: string) {
    postMessage({ command: 'removeInstance', id });
  }

  function exportInstances(ids?: string[]) {
    postMessage({ command: 'exportInstances', ids });
  }

  function copyInstancesToClipboard(ids?: string[]) {
    postMessage({ command: 'copyInstancesToClipboard', ids });
  }

  function previewImportInstances() {
    importPreviewToken += 1;
    if (importPreviewInFlightToken !== 0) {
      return;
    }
    importPreviewInFlightToken = importPreviewToken;
    postMessage({ command: 'previewImportInstances' });
  }

  function confirmImportInstances(ids: string[], settings?: ExportSettings) {
    // Only the selected ids cross over: the host rehydrates the full entries
    // (tokens included) from the stash it kept when previewing the file.
    postMessage({
      command: 'importInstances',
      ids: [...ids],
      settings: settings ? { ...settings } : undefined,
    });
  }

  function cancelImportInstances() {
    postMessage({ command: 'cancelImportInstances' });
  }

  function changeLocale(newLocale: Locale) {
    locale.value = newLocale;
    postMessage({ command: 'setLocale', locale: newLocale });
  }

  // `<html lang>` follows the locale the UI renders in (screen readers pick
  // their language rules from it): the host can push a locale (initial state, a
  // settings change from another panel), so watch the state rather than only
  // the local changeLocale call.
  watch(locale, (value) => {
    document.documentElement.lang = localeTag(value as Locale);
  });

  function changeDebug(newDebug: boolean) {
    debug.value = newDebug;
    postMessage({ command: 'setDebug', debug: newDebug });
  }

  function openRepoDetail(instanceId: string, owner: string, repo: string) {
    router.push({ name: 'repoDetail', params: { instanceId, owner, repo } });
    loadRepoDetail(instanceId, owner, repo);
  }

  function loadRepoDetail(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoDetailKey(instanceId, owner, repo);
    if (!force && repoDetailsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoDetail', instanceId, owner, repo });
  }

  function loadRepoBranchCommits(instanceId: string, owner: string, repo: string, branch: string, force = false) {
    const key = repoBranchCommitsKey(instanceId, owner, repo, branch);
    if (!force && repoBranchCommitsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoBranchCommits', instanceId, owner, repo, branch });
  }

  function openRepoFile(instanceId: string, owner: string, repo: string, path: string, ref: string) {
    postMessage({ command: 'openRepoFile', instanceId, owner, repo, path, ref });
  }

  function openRepoFileDiff(
    instanceId: string,
    owner: string,
    repo: string,
    path: string,
    baseRef: string,
    headRef: string,
  ) {
    postMessage({ command: 'openRepoFileDiff', instanceId, owner, repo, path, baseRef, headRef });
  }

  function loadRepoContents(instanceId: string, owner: string, repo: string, path: string, ref: string, force = false) {
    const key = repoContentsKey(instanceId, owner, repo, ref, path);
    if (!force && repoContentsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoContents', instanceId, owner, repo, path, ref });
  }

  function loadRepoFileSearch(instanceId: string, owner: string, repo: string, ref: string, query: string) {
    const key = repoFileSearchKey(instanceId, owner, repo, ref, query);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'searchRepoFiles', instanceId, owner, repo, ref, query });
  }

  function loadFileHistory(instanceId: string, owner: string, repo: string, path: string, ref: string) {
    const key = fileHistoryKey(instanceId, owner, repo, path, ref);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getFileHistory', instanceId, owner, repo, path, ref });
  }

  function loadRepoRefs(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoRefsKey(instanceId, owner, repo);
    if (!force && repoRefsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoRefs', instanceId, owner, repo });
  }

  function createRepoBranch(
    instanceId: string,
    owner: string,
    repo: string,
    newBranchName: string,
    oldRefName?: string,
  ) {
    postMessage({ command: 'createRepoBranch', instanceId, owner, repo, newBranchName, oldRefName });
  }

  function deleteRepoBranch(instanceId: string, owner: string, repo: string, branch: string) {
    postMessage({ command: 'deleteRepoBranch', instanceId, owner, repo, branch });
  }

  function createRepoTag(
    instanceId: string,
    owner: string,
    repo: string,
    tagName: string,
    target?: string,
    message?: string,
  ) {
    postMessage({ command: 'createRepoTag', instanceId, owner, repo, tagName, target, message });
  }

  function deleteRepoTag(instanceId: string, owner: string, repo: string, tag: string) {
    postMessage({ command: 'deleteRepoTag', instanceId, owner, repo, tag });
  }

  function createRepoRelease(
    instanceId: string,
    owner: string,
    repo: string,
    tagName: string,
    name?: string,
    body?: string,
    targetCommitish?: string,
    prerelease?: boolean,
    draft?: boolean,
    hideArchiveLinks?: boolean,
  ): Promise<ForgejoRelease> {
    const key = repoRefsKey(instanceId, owner, repo);
    beginLoading(key);
    const _requestId = `release-create-${++releaseCreationRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(
        pendingReleaseCreations,
        _requestId,
        'createRepoRelease',
        { resolve, reject },
        { loadingKey: key },
      );
      postMessage({
        command: 'createRepoRelease',
        instanceId,
        owner,
        repo,
        tagName,
        name,
        body,
        targetCommitish,
        prerelease,
        draft,
        hideArchiveLinks,
        _requestId,
      });
    });
  }

  function editRepoRelease(
    instanceId: string,
    owner: string,
    repo: string,
    id: number,
    data: {
      tag_name?: string;
      name?: string;
      body?: string;
      target_commitish?: string;
      prerelease?: boolean;
      draft?: boolean;
      hide_archive_links?: boolean;
    },
  ) {
    postMessage({ command: 'editRepoRelease', instanceId, owner, repo, id, data });
  }

  function deleteRepoRelease(instanceId: string, owner: string, repo: string, id: number) {
    postMessage({ command: 'deleteRepoRelease', instanceId, owner, repo, id });
  }

  function uploadReleaseAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    id: number,
    name: string,
    data: Uint8Array,
  ): Promise<ForgejoReleaseAttachment> {
    const _requestId = `release-attachment-${++inputRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(
        releaseAttachmentPromises,
        _requestId,
        'createReleaseAttachment',
        { resolve, reject },
        {
          makeTimeoutError: () => t('common.requestTimeout'),
        },
      );
      postMessage({
        command: 'createReleaseAttachment',
        instanceId,
        owner,
        repo,
        id,
        name,
        data: Array.from(data),
        _requestId,
      });
    });
  }

  /**
   * Resolves `true` when the release attachment was deleted and `false` when
   * the user declined the host-side confirmation.
   */
  function deleteReleaseAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    id: number,
    attachmentId: number,
  ): Promise<boolean> {
    const _requestId = `release-attachment-delete-${++inputRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(
        releaseAttachmentDeletePromises,
        _requestId,
        'deleteReleaseAttachment',
        { resolve, reject },
        {
          makeTimeoutError: () => t('common.requestTimeout'),
        },
      );
      postMessage({
        command: 'deleteReleaseAttachment',
        instanceId,
        owner,
        repo,
        id,
        attachmentId,
        _requestId,
      });
    });
  }

  function showInputBox(options: {
    prompt: string;
    value?: string;
    placeHolder?: string;
  }): Promise<string | undefined> {
    const id = `input-${++inputRequestId}`;
    return new Promise((resolve) => {
      inputBoxPromises.set(id, resolve);
      postMessage({ command: 'showInputBox', id, ...options });
    });
  }

  function showConfirm(message: string): Promise<boolean> {
    const id = `confirm-${++inputRequestId}`;
    return new Promise((resolve) => {
      confirmPromises.set(id, resolve);
      postMessage({
        command: 'showConfirm',
        id,
        message,
        confirmLabel: t('common.confirm'),
      });
    });
  }

  function createIssue(
    instanceId: string,
    owner: string,
    repo: string,
    data: {
      title: string;
      body: string;
      ref?: string;
      labels?: number[];
      assignees?: string[];
      milestone?: number;
      dueDate?: string;
    },
  ): Promise<ForgejoIssue> {
    const key = issueFormKey(instanceId, owner, repo, 0);
    beginLoading(key);
    const _requestId = `issue-create-${++issueCreationRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(pendingIssueCreations, _requestId, 'createIssue', { resolve, reject }, { loadingKey: key });
      postMessage({
        command: 'createIssue',
        instanceId,
        owner,
        repo,
        data: {
          title: data.title,
          body: data.body,
          ref: data.ref,
          labels: data.labels,
          assignees: data.assignees,
          milestone: data.milestone,
          due_date: data.dueDate,
        },
        _requestId,
      });
    });
  }

  function editIssue(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      labels?: number[];
      assignees?: string[];
      milestone?: number;
      dueDate?: string;
      unsetDueDate?: boolean;
    },
  ) {
    const key = issueFormKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'editIssue',
      instanceId,
      owner,
      repo,
      index,
      data: {
        title: data.title,
        body: data.body,
        state: data.state,
        labels: data.labels,
        assignees: data.assignees,
        milestone: data.milestone,
        due_date: data.dueDate,
        unset_due_date: data.unsetDueDate,
      },
    });
  }

  function deleteIssue(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueDetailKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'deleteIssue',
      instanceId,
      owner,
      repo,
      index,
    });
  }

  /**
   * Close/reopen an issue from the detail view. Uses its own loading/error key
   * (echoed back as `stateToggle`) so a failure shows next to the button
   * instead of inside the edit form's key, which the user may never open.
   */
  function toggleIssueState(instanceId: string, owner: string, repo: string, index: number, state: 'open' | 'closed') {
    const key = issueStateKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'editIssue',
      instanceId,
      owner,
      repo,
      index,
      data: { state, state_toggle: true },
    });
  }

  /**
   * Update only the due date from the detail view's inline editor. Uses its
   * own loading/error key (echoed back as `dueDateUpdate`) so a failure shows
   * next to the inline editor instead of inside the edit form's key, which
   * the user may never open.
   */
  function updateIssueDueDate(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: { dueDate?: string; unsetDueDate?: boolean },
  ) {
    const key = issueDueDateKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'editIssue',
      instanceId,
      owner,
      repo,
      index,
      data: { due_date: data.dueDate, unset_due_date: data.unsetDueDate, due_date_update: true },
    });
  }

  function createIssueComment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    body: string,
  ): Promise<ForgejoTimelineComment> {
    const key = issueCommentFormKey(instanceId, owner, repo, index);
    beginLoading(key);
    const _requestId = `issue-comment-create-${++issueCommentCreationRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(
        pendingIssueCommentCreations,
        _requestId,
        'createIssueComment',
        { resolve, reject },
        { loadingKey: key },
      );
      postMessage({ command: 'createIssueComment', instanceId, owner, repo, index, body, _requestId });
    });
  }

  function editIssueComment(instanceId: string, owner: string, repo: string, commentId: number, body: string) {
    const key = issueCommentEditFormKey(instanceId, owner, repo, commentId);
    beginLoading(key);
    postMessage({ command: 'editIssueComment', instanceId, owner, repo, commentId, body });
  }

  // No webview-side confirmation here: the host re-confirms destructive
  // commands itself before executing (see viewProvider).
  function deleteIssueComment(instanceId: string, owner: string, repo: string, commentId: number) {
    const key = issueCommentDeleteFormKey(instanceId, owner, repo, commentId);
    beginLoading(key);
    postMessage({ command: 'deleteIssueComment', instanceId, owner, repo, commentId });
  }

  /**
   * Resolves `true` when the attachment was deleted and `false` when the user
   * declined the host-side confirmation.
   */
  function deleteIssueCommentAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    commentId: number,
    attachmentId: number,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}:comment-${commentId}:attachment-delete:${++attachmentDeleteRequestId}`;
      registerPending(pendingAttachmentDeletes, id, 'deleteIssueCommentAttachment', { resolve, reject });
      postMessage({
        command: 'deleteIssueCommentAttachment',
        instanceId,
        owner,
        repo,
        commentId,
        attachmentId,
        _requestId: id,
      });
    });
  }

  function mergePullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    strategy: 'merge' | 'rebase' | 'squash',
  ) {
    const key = pullRequestMergeFormKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'mergePullRequest', instanceId, owner, repo, index, strategy });
  }

  function revertMergeCommit(instanceId: string, owner: string, repo: string, index: number) {
    const key = `revert-merge:${instanceId}:${owner}/${repo}#${index}`;
    beginLoading(key);
    postMessage({ command: 'revertMergeCommit', instanceId, owner, repo, index });
  }

  function uploadIssueAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    file: File,
  ): Promise<ForgejoIssueAttachment> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}#issue-${index}:attachment:${++attachmentUploadRequestId}`;
      registerPending(pendingAttachmentUploads, id, 'createIssueAttachment', { resolve, reject });
      const reader = new FileReader();
      reader.onload = () => {
        const array = new Uint8Array(reader.result as ArrayBuffer);
        postMessage({
          command: 'createIssueAttachment',
          instanceId,
          owner,
          repo,
          index,
          name: file.name,
          data: Array.from(array),
          _requestId: id,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error(t('common.readFileFailed')));
      reader.readAsArrayBuffer(file);
    });
  }

  function uploadIssueCommentAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    commentId: number,
    file: File,
  ): Promise<ForgejoIssueAttachment> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}#issue-${index}:comment-${commentId}:attachment:${++attachmentUploadRequestId}`;
      registerPending(pendingAttachmentUploads, id, 'createIssueCommentAttachment', { resolve, reject });
      const reader = new FileReader();
      reader.onload = () => {
        const array = new Uint8Array(reader.result as ArrayBuffer);
        postMessage({
          command: 'createIssueCommentAttachment',
          instanceId,
          owner,
          repo,
          index,
          commentId,
          name: file.name,
          data: Array.from(array),
          _requestId: id,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error(t('common.readFileFailed')));
      reader.readAsArrayBuffer(file);
    });
  }

  /**
   * Resolves `true` when the attachment was deleted and `false` when the user
   * declined the host-side confirmation.
   */
  function deleteIssueAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}#issue-${index}:attachment-delete:${++attachmentDeleteRequestId}`;
      registerPending(pendingAttachmentDeletes, id, 'deleteIssueAttachment', { resolve, reject });
      postMessage({
        command: 'deleteIssueAttachment',
        instanceId,
        owner,
        repo,
        index,
        attachmentId,
        _requestId: id,
      });
    });
  }

  function createPullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    data: {
      title: string;
      body: string;
      base?: string;
      head?: string;
      assignees?: string[];
      labels?: number[];
      milestone?: number;
      dueDate?: string;
    },
  ): Promise<ForgejoPullRequest> {
    const key = pullRequestFormKey(instanceId, owner, repo, 0);
    beginLoading(key);
    const _requestId = `pull-request-create-${++pullRequestCreationRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(
        pendingPullRequestCreations,
        _requestId,
        'createPullRequest',
        { resolve, reject },
        { loadingKey: key },
      );
      postMessage({
        command: 'createPullRequest',
        instanceId,
        owner,
        repo,
        data: {
          title: data.title,
          body: data.body,
          base: data.base,
          head: data.head,
          assignees: data.assignees,
          labels: data.labels,
          milestone: data.milestone,
          due_date: data.dueDate,
        },
        _requestId,
      });
    });
  }

  function editPullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      base?: string;
      assignees?: string[];
      labels?: number[];
      milestone?: number;
      dueDate?: string;
      unsetDueDate?: boolean;
    },
  ) {
    const key = pullRequestFormKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'editPullRequest',
      instanceId,
      owner,
      repo,
      index,
      data: {
        title: data.title,
        body: data.body,
        state: data.state,
        base: data.base,
        assignees: data.assignees,
        labels: data.labels,
        milestone: data.milestone,
        due_date: data.dueDate,
        unset_due_date: data.unsetDueDate,
      },
    });
  }

  /** See toggleIssueState: close/reopen gets its own loading/error key. */
  function togglePullRequestState(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    state: 'open' | 'closed',
  ) {
    const key = pullRequestStateKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'editPullRequest',
      instanceId,
      owner,
      repo,
      index,
      data: { state, state_toggle: true },
    });
  }

  /** See updateIssueDueDate: the inline due-date editor gets its own key. */
  function updatePullRequestDueDate(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: { dueDate?: string; unsetDueDate?: boolean },
  ) {
    const key = pullRequestDueDateKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({
      command: 'editPullRequest',
      instanceId,
      owner,
      repo,
      index,
      data: { due_date: data.dueDate, unset_due_date: data.unsetDueDate, due_date_update: true },
    });
  }

  function openIssueDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'issueDetail', params: { instanceId, owner, repo, index: String(index) } });
    loadIssueDetail(instanceId, owner, repo, index);
  }

  function loadIssueDetail(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueDetailKey(instanceId, owner, repo, index);
    if (!force && issueDetailCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getIssueDetail', instanceId, owner, repo, index });
  }

  function openPullRequestDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'pullRequestDetail', params: { instanceId, owner, repo, index: String(index) } });
    loadPullRequestDetail(instanceId, owner, repo, index);
  }

  function loadPullRequestDetail(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestDetailKey(instanceId, owner, repo, index);
    if (!force && pullRequestDetailCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getPullRequestDetail', instanceId, owner, repo, index });
  }

  function loadPullRequestFiles(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    baseSha?: string,
    headSha?: string,
    force = false,
  ) {
    const key = pullRequestFilesKey(instanceId, owner, repo, index, baseSha, headSha);
    if (!force && pullRequestFilesCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getPullRequestFiles', instanceId, owner, repo, index, baseSha, headSha });
  }

  function loadPullRequestComments(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestCommentsKey(instanceId, owner, repo, index);
    if (!force && pullRequestCommentsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getPullRequestCommentsAndTimeline', instanceId, owner, repo, index });
  }

  function loadPullRequestCommits(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestCommitsKey(instanceId, owner, repo, index);
    if (!force && pullRequestCommitsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getPullRequestCommits', instanceId, owner, repo, index });
  }

  function openPullRequestDiff(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    filename: string,
    status: string,
    baseSha: string,
    headSha: string,
    previousFilename?: string,
  ) {
    postMessage({
      command: 'openPullRequestDiff',
      instanceId,
      owner,
      repo,
      index,
      filename,
      status,
      previousFilename,
      baseSha,
      headSha,
    });
  }

  function openSelectedPullRequestDiffs(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    files: { filename: string; status: string; previous_filename?: string }[],
    baseSha: string,
    headSha: string,
  ) {
    postMessage({
      command: 'openSelectedPullRequestDiffs',
      instanceId,
      owner,
      repo,
      index,
      files,
      baseSha,
      headSha,
    });
  }

  function openRepoIssues(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoIssues', params: { instanceId, owner, repo, state } });
    loadRepoIssues(instanceId, owner, repo, state);
  }

  function loadRepoIssues(instanceId: string, owner: string, repo: string, state = 'open', query?: string) {
    const key = repoIssuesKey(instanceId, owner, repo, state, query);
    if (repoIssues.value.has(key) && isMarkFresh(repoIssuesFetchedAt.get(key), REPO_LIST_MARKS_TTL_MS)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoIssues', instanceId, owner, repo, state, query: query?.trim() || undefined });
  }

  function loadRepoLabels(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoLabelsKey(instanceId, owner, repo);
    if (!force && repoLabelsCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoLabels', instanceId, owner, repo });
  }

  function loadRepoAssignees(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoAssigneesKey(instanceId, owner, repo);
    if (!force && repoAssigneesCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoAssignees', instanceId, owner, repo });
  }

  function loadRepoMilestones(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoMilestonesKey(instanceId, owner, repo);
    if (!force && repoMilestonesCache.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepoMilestones', instanceId, owner, repo });
  }

  function loadIssueSubscription(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueSubscriptionKey(instanceId, owner, repo, index);
    if (!force && issueSubscriptions.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'checkIssueSubscription', instanceId, owner, repo, index });
  }

  function changeIssueSubscription(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    user: string,
    subscribe: boolean,
  ) {
    const key = issueSubscriptionKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'changeIssueSubscription', instanceId, owner, repo, index, user, subscribe });
  }

  function loadUserStopwatches(instanceId: string, force = false) {
    const key = userStopwatchesKey(instanceId);
    if (!force && userStopwatches.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getUserStopwatches', instanceId });
  }

  function loadIssueTrackedTimes(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    if (!force && issueTrackedTimes.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getIssueTrackedTimes', instanceId, owner, repo, index });
  }

  function startIssueStopwatch(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'startIssueStopwatch', instanceId, owner, repo, index });
  }

  function stopIssueStopwatch(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'stopIssueStopwatch', instanceId, owner, repo, index });
  }

  function deleteIssueStopwatch(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'deleteIssueStopwatch', instanceId, owner, repo, index });
  }

  function addIssueTime(instanceId: string, owner: string, repo: string, index: number, time: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'addIssueTime', instanceId, owner, repo, index, time });
  }

  function resetIssueTime(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'resetIssueTime', instanceId, owner, repo, index });
  }

  function deleteIssueTime(instanceId: string, owner: string, repo: string, index: number, id: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'deleteIssueTime', instanceId, owner, repo, index, id });
  }

  function loadIssueDependencies(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueDependenciesKey(instanceId, owner, repo, index);
    if (!force && issueDependencies.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getIssueDependencies', instanceId, owner, repo, index });
  }

  function createIssueDependency(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    dependencyIndex: number,
  ) {
    const key = issueDependenciesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'createIssueDependency', instanceId, owner, repo, index, dependencyIndex });
  }

  function removeIssueDependency(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    dependencyIndex: number,
  ) {
    const key = issueDependenciesKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'removeIssueDependency', instanceId, owner, repo, index, dependencyIndex });
  }

  function loadIssueReactions(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueReactionsKey(instanceId, owner, repo, index);
    if (!force && issueReactions.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getIssueReactions', instanceId, owner, repo, index });
  }

  function changeIssueReaction(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    content: string,
    add: boolean,
  ) {
    const key = issueReactionsKey(instanceId, owner, repo, index);
    beginLoading(key);
    postMessage({ command: 'changeIssueReaction', instanceId, owner, repo, index, content, add });
  }

  // A rendered comment shows its reaction counts, so every timeline entry asks for
  // them — up to MAX_ITEMS entries on a busy pull request. At most this many requests
  // are in flight at once; the rest wait their turn so the host is not hit with
  // hundreds of parallel requests (each reply releases the next one, error included).
  const MAX_REACTION_REQUESTS_IN_FLIGHT = 4;
  let reactionRequestsInFlight = 0;
  const queuedReactionRequests: Array<() => void> = [];

  function releaseReactionRequestSlot() {
    reactionRequestsInFlight = Math.max(0, reactionRequestsInFlight - 1);
    queuedReactionRequests.shift()?.();
  }

  function loadCommentReactions(instanceId: string, owner: string, repo: string, commentId: number, force = false) {
    const key = commentReactionsKey(instanceId, owner, repo, commentId);
    if (!force && commentReactions.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    const send = () => {
      reactionRequestsInFlight++;
      postMessage({ command: 'getCommentReactions', instanceId, owner, repo, commentId });
    };
    if (reactionRequestsInFlight < MAX_REACTION_REQUESTS_IN_FLIGHT) {
      send();
    } else {
      queuedReactionRequests.push(send);
    }
  }

  function changeCommentReaction(
    instanceId: string,
    owner: string,
    repo: string,
    commentId: number,
    content: string,
    add: boolean,
  ) {
    const key = commentReactionsKey(instanceId, owner, repo, commentId);
    beginLoading(key);
    postMessage({ command: 'changeCommentReaction', instanceId, owner, repo, commentId, content, add });
  }

  function openRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoPullRequests', params: { instanceId, owner, repo, state } });
    loadRepoPullRequests(instanceId, owner, repo, state);
  }

  function consumePendingCreatePr(instanceId: string, owner: string, repo: string) {
    const pending = pendingCreatePr.value;
    if (!pending || pending.instanceId !== instanceId || pending.owner !== owner || pending.repo !== repo) {
      return undefined;
    }
    pendingCreatePr.value = null;
    return pending;
  }

  function consumePendingNewIssue(instanceId: string, owner: string, repo: string) {
    const pending = pendingNewIssue.value;
    if (!pending || pending.instanceId !== instanceId || pending.owner !== owner || pending.repo !== repo) {
      return undefined;
    }
    pendingNewIssue.value = null;
    return pending;
  }

  function loadRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open', query?: string) {
    const key = repoPullRequestsKey(instanceId, owner, repo, state, query);
    if (repoPullRequests.value.has(key) && isMarkFresh(repoPullRequestsFetchedAt.get(key), REPO_LIST_MARKS_TTL_MS)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({
      command: 'getRepoPullRequests',
      instanceId,
      owner,
      repo,
      state,
      query: query?.trim() || undefined,
    });
  }

  function loadActionRuns(instanceId: string, owner: string, repo: string, page = 1, _force = false) {
    // Requesting page 1 reloads the list from the start; higher pages append
    // to it. Loading state is per repo, so a second page request while the
    // first is in flight is dropped rather than queued.
    const key = actionRunsKey(instanceId, owner, repo);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getActionRuns', instanceId, owner, repo, page, limit: ACTION_RUNS_PAGE_LIMIT });
  }

  function openActionRunDetail(instanceId: string, owner: string, repo: string, runId: number) {
    router.push({ name: 'actionRunDetail', params: { instanceId, owner, repo, runId: String(runId) } });
    loadActionRun(instanceId, owner, repo, runId);
    loadActionRunJobs(instanceId, owner, repo, runId);
    loadActionRunArtifacts(instanceId, owner, repo, runId);
  }

  function loadActionRun(instanceId: string, owner: string, repo: string, runId: number, _force = false) {
    const key = actionRunKey(instanceId, owner, repo, runId);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getActionRun', instanceId, owner, repo, runId });
  }

  function loadActionRunJobs(instanceId: string, owner: string, repo: string, runId: number, _force = false) {
    const key = actionRunJobsKey(instanceId, owner, repo, runId);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getActionRunJobs', instanceId, owner, repo, runId });
  }

  function loadActionRunArtifacts(instanceId: string, owner: string, repo: string, runId: number, _force = false) {
    const key = actionRunArtifactsKey(instanceId, owner, repo, runId);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getActionRunArtifacts', instanceId, owner, repo, runId });
  }

  function loadActionJobLog(instanceId: string, owner: string, repo: string, jobId: number, force = false) {
    const key = actionJobLogKey(instanceId, owner, repo, jobId);
    if (!force && actionJobLogs.value.has(key)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getActionJobLog', instanceId, owner, repo, jobId });
  }

  function dispatchWorkflow(
    instanceId: string,
    owner: string,
    repo: string,
    workflowfilename: string,
    ref: string,
    inputs?: Record<string, string>,
  ) {
    const key = dispatchWorkflowKey(instanceId, owner, repo, workflowfilename);
    beginLoading(key);
    postMessage({ command: 'dispatchWorkflow', instanceId, owner, repo, workflowfilename, ref, inputs });
  }

  function cancelActionRun(instanceId: string, owner: string, repo: string, runId: number) {
    const key = actionRunCancelKey(instanceId, owner, repo, runId);
    beginLoading(key);
    postMessage({ command: 'cancelActionRun', instanceId, owner, repo, runId });
  }

  function deleteActionRun(instanceId: string, owner: string, repo: string, runId: number) {
    const key = actionRunDeleteKey(instanceId, owner, repo, runId);
    beginLoading(key);
    postMessage({ command: 'deleteActionRun', instanceId, owner, repo, runId });
  }

  function downloadActionArtifact(instanceId: string, owner: string, repo: string, artifactId: number, name: string) {
    const key = actionArtifactDownloadKey(instanceId, owner, repo, artifactId);
    beginLoading(key);
    postMessage({ command: 'downloadActionArtifact', instanceId, owner, repo, artifactId, name });
  }

  function changeRepoIssuesState(instanceId: string, owner: string, repo: string, newState: string) {
    router.replace({ name: 'repoIssues', params: { instanceId, owner, repo, state: newState } });
    loadRepoIssues(instanceId, owner, repo, newState);
  }

  function changeRepoPullRequestsState(instanceId: string, owner: string, repo: string, newState: string) {
    router.replace({ name: 'repoPullRequests', params: { instanceId, owner, repo, state: newState } });
    loadRepoPullRequests(instanceId, owner, repo, newState);
  }

  function loadLinkedRepository() {
    postMessage({ command: 'getLinkedRepository' });
  }

  function selectLinkedRepository(localPath: string | undefined) {
    selectedLinkedRepoPath.value = localPath;
  }

  function openLinkedRepositoryDetail() {
    const linked = activeLinkedRepository.value;
    if (!linked) {
      return;
    }
    openRepoDetail(linked.instanceId, linked.owner, linked.repo);
  }

  function openLinkedRepositoryIssues() {
    const linked = activeLinkedRepository.value;
    if (!linked) {
      return;
    }
    openRepoIssues(linked.instanceId, linked.owner, linked.repo);
  }

  function openLinkedRepositoryPullRequests() {
    const linked = activeLinkedRepository.value;
    if (!linked) {
      return;
    }
    openRepoPullRequests(linked.instanceId, linked.owner, linked.repo);
  }

  function openPrWorktree(instanceId: string, owner: string, repo: string, index: number) {
    postMessage({ command: 'openPrWorktree', instanceId, owner, repo, index });
  }

  function startWorkOnIssue(instanceId: string, owner: string, repo: string, index: number, title?: string) {
    beginLoading(startWorkKey(instanceId, owner, repo, index));
    postMessage({ command: 'startWorkOnIssue', instanceId, owner, repo, index, title });
  }

  /**
   * Adds the worktree a "Start work" created to the list Settings renders.
   *
   * The host records the worktree before opening it and answers with a bare
   * `startWorkResult`, so nothing carried it to the webview and the new worktree
   * never appeared under Settings until the next full state snapshot. The
   * webview cannot invent it (the id and branch name are host-generated), so it
   * merges the record when the host includes one — the reply is typed as
   * `startWorkResult` plus a `worktree` field, the same shape `worktreeOpened`
   * already carries and the same merge this applies.
   */
  function registerStartWorkWorktree(worktree: ForgejoPullRequestWorktreeInfo) {
    if (!worktree || typeof worktree.id !== 'string' || worktree.id.length === 0) {
      return;
    }
    const list = worktrees.value.filter((entry) => entry.id !== worktree.id);
    list.push(worktree);
    worktrees.value = list;
  }

  function removeWorktree(id: string) {
    postMessage({ command: 'removeWorktree', id });
  }

  function changeWorktreeOpenMode(mode: 'ask' | 'currentWindow' | 'newWindow') {
    worktreeOpenMode.value = mode;
    postMessage({ command: 'setWorktreeOpenMode', mode });
  }

  function setWorktreeCacheDirectory(directory: string) {
    worktreeCacheDirectory.value = directory;
    postMessage({ command: 'setWorktreeCacheDirectory', directory });
  }

  function setDashboardActiveTab(tab: 'repositories' | 'issues' | 'pullRequests') {
    dashboardActiveTab.value = tab;
  }

  function browseWorktreeCacheDirectory() {
    postMessage({ command: 'browseWorktreeCacheDirectory' });
  }

  function renderMarkdown(instanceId: string, text: string, context?: string): Promise<string> {
    const cacheKey = `${instanceId}:${context ?? ''}:${text}`;
    const cached = renderedMarkdownCache.get(cacheKey);
    if (cached !== undefined) {
      return Promise.resolve(cached);
    }
    const inFlight = inFlightRenderMarkdown.get(cacheKey);
    if (inFlight) {
      return inFlight;
    }
    const _requestId = `render-${++renderMarkdownRequestId}`;
    const promise = new Promise<string>((resolve, reject) => {
      registerPending(
        pendingRenderMarkdownRequests,
        _requestId,
        'renderMarkdown',
        { resolve, reject },
        { extra: { cacheKey } },
      );
      postMessage({ command: 'renderMarkdown', instanceId, text, context, _requestId });
    });
    inFlightRenderMarkdown.set(cacheKey, promise);
    const dropInFlight = () => {
      if (inFlightRenderMarkdown.get(cacheKey) === promise) {
        inFlightRenderMarkdown.delete(cacheKey);
      }
    };
    promise.then(dropInFlight, dropInFlight);
    return promise;
  }

  function searchMentions(
    instanceId: string,
    owner: string,
    repo: string,
    query: string,
    type: 'user' | 'issue' | 'all',
  ): Promise<{ users: MentionUser[]; issues: MentionIssue[] }> {
    const _requestId = `mention-${++mentionSearchRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(pendingMentionSearchRequests, _requestId, 'searchMentions', { resolve, reject });
      postMessage({ command: 'searchMentions', instanceId, owner, repo, query, type, _requestId });
    });
  }

  function getUserPreview(instanceId: string, username: string): Promise<ForgejoUser | undefined> {
    const _requestId = `user-preview-${++userPreviewRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(pendingUserPreviewRequests, _requestId, 'getUserPreview', { resolve, reject });
      postMessage({ command: 'getUserPreview', instanceId, username, _requestId });
    });
  }

  function getIssuePreview(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
  ): Promise<ForgejoIssue | undefined> {
    const _requestId = `issue-preview-${++issuePreviewRequestId}`;
    return new Promise((resolve, reject) => {
      registerPending(pendingIssuePreviewRequests, _requestId, 'getIssuePreview', { resolve, reject });
      postMessage({ command: 'getIssuePreview', instanceId, owner, repo, index, _requestId });
    });
  }

  function loadRepositories(instanceId: string, force = false) {
    const key = `repos-${instanceId}`;
    if (!force && repositoriesCache.has(instanceId)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getRepositories', instanceId });
  }

  /** `${instanceId}:${owner}/${repo}` — the prefix of every repo-scoped payload key. */
  function repoScopePrefix(instanceId: string, owner: string, repo: string): string {
    return `${instanceId}:${owner}/${repo}`;
  }

  /**
   * Releases everything held for one repository: its reactive payload slots
   * (issue and pull request lists and details, timelines, diffs, file trees, CI
   * runs and job logs) and the TTL response caches that back them. Called when
   * the user navigates to another repository, so a long session (the whole
   * webview is kept alive with `retainContextWhenHidden`) frees what it no longer
   * shows instead of holding it until the window closes. The TTL caches are
   * dropped together with the payloads on purpose: leaving a live cache entry
   * behind would make the next visit a cache hit whose payload has just been
   * deleted, and the view would sit on an empty list.
   *
   * `MAX_PAYLOAD_ENTRIES` is the second half of the policy: it bounds how many
   * repositories, issues, paths or queries may be held at once even when the user
   * only ever navigates forward.
   */
  function clearRepoPayloads(prefix: string): void {
    clearRepoScope(repoDetails.value, prefix);
    clearRepoScope(issueDetails.value, prefix);
    clearRepoScope(pullRequestDetails.value, prefix);
    clearRepoScope(repoIssues.value, prefix);
    clearRepoScope(repoPullRequests.value, prefix);
    clearRepoScope(repoBranchCommits.value, prefix);
    clearRepoScope(pullRequestFiles.value, prefix);
    clearRepoScope(pullRequestComments.value, prefix);
    clearRepoScope(pullRequestCommits.value, prefix);
    clearRepoScope(repoContents.value, prefix);
    clearRepoScope(repoRefs.value, prefix);
    clearRepoScope(repoFileSearchResults.value, prefix);
    clearRepoScope(repoFileSearchTruncated.value, prefix);
    clearRepoScope(fileHistories.value, prefix);
    clearRepoScope(repoLabels.value, prefix);
    clearRepoScope(repoAssignees.value, prefix);
    clearRepoScope(repoMilestones.value, prefix);
    clearRepoScope(actionRuns.value, prefix);
    clearRepoScope(actionRunsPage.value, prefix);
    clearRepoScope(actionRunsHasMore.value, prefix);
    clearRepoScope(actionRunTotalCount.value, prefix);
    clearRepoScope(actionRunDetails.value, prefix);
    clearRepoScope(actionRunJobs.value, prefix);
    clearRepoScope(actionRunArtifacts.value, prefix);
    clearRepoScope(actionJobLogs.value, prefix);
    clearRepoScope(issueSubscriptions.value, prefix);
    clearRepoScope(issueTrackedTimes.value, prefix);
    clearRepoScope(issueDependencies.value, prefix);
    clearRepoScope(issueReactions.value, prefix);
    clearRepoScope(commentReactions.value, prefix);

    const inScope = (key: string) => isInRepoScope(key, prefix);
    repoDetailsCache.deleteWhere(inScope);
    issueDetailCache.deleteWhere(inScope);
    pullRequestDetailCache.deleteWhere(inScope);
    pullRequestCommentsCache.deleteWhere(inScope);
    pullRequestFilesCache.deleteWhere(inScope);
    pullRequestCommitsCache.deleteWhere(inScope);
    repoContentsCache.deleteWhere(inScope);
    repoRefsCache.deleteWhere(inScope);
    repoBranchCommitsCache.deleteWhere(inScope);
    repoLabelsCache.deleteWhere(inScope);
    repoAssigneesCache.deleteWhere(inScope);
    repoMilestonesCache.deleteWhere(inScope);
    clearWhere(repoIssuesFetchedAt, inScope);
    clearWhere(repoPullRequestsFetchedAt, inScope);
  }

  /**
   * Drops one repository's issue lists — every state and search key — together
   * with the "list is fresh" marks that guard them. The marks must go too: the
   * loader only refetches when both the list and its mark are missing, so a
   * deleted slot would otherwise be served as fresh for the rest of the TTL.
   */
  function invalidateRepoIssueLists(prefix: string): void {
    clearByPrefix(repoIssues.value, `${prefix}:issues:`);
    clearWhere(repoIssuesFetchedAt, (key) => key.startsWith(`${prefix}:issues:`));
  }

  /** Same as `invalidateRepoIssueLists` for the pull request lists. */
  function invalidateRepoPullRequestLists(prefix: string): void {
    clearByPrefix(repoPullRequests.value, `${prefix}:pulls:`);
    clearWhere(repoPullRequestsFetchedAt, (key) => key.startsWith(`${prefix}:pulls:`));
  }

  // The repository the route currently points at. Navigating to another one
  // releases the payloads of the one left behind; the views stay alive in the
  // keep-alive cache, so nothing else would free them. A router hook rather than
  // a `watch`: a watcher created here would live in the effect scope of whichever
  // component happened to call `useAppState()` first and would stop working once
  // the keep-alive cache evicts that component.
  let activeRepoScope: string | undefined;
  // `useRouter()` injects, it does not throw: the two standalone panels
  // (onboarding, pull request review comment) mount the composable without a
  // vue-router instance, so the hook may only be installed when one exists.
  router?.afterEach((to) => {
    const instanceId = to.params.instanceId;
    const owner = to.params.owner;
    const repo = to.params.repo;
    const scope =
      typeof instanceId === 'string' && typeof owner === 'string' && typeof repo === 'string'
        ? repoScopePrefix(instanceId, owner, repo)
        : undefined;
    const previous = activeRepoScope;
    activeRepoScope = scope;
    if (previous && previous !== scope) {
      clearRepoPayloads(previous);
    }
  });

  /**
   * Releases every payload and TTL cache held for one instance.
   *
   * The instance list is keyed by id, and an edit keeps that id, so URL or
   * account changes would otherwise leave the previous server's repositories,
   * issues, files and runs on screen (they are keyed by the same id and served
   * from caches the edit never invalidated). Repo-scoped slots share the
   * `${instanceId}:` prefix, so they are dropped with the same clear.
   */
  function clearInstancePayloads(instanceId: string): void {
    const inScope = (key: string) => key.startsWith(`${instanceId}:`);
    // Repo-scoped slots carry their own prefix (`${instanceId}:${owner}/${repo}`)
    // with a separator that is itself part of the instance prefix.
    clearWhere(repositories.value, (key) => key === instanceId);
    clearWhere(myIssues.value, (key) => key === instanceId);
    clearWhere(myPullRequests.value, (key) => key === instanceId);
    clearWhere(notifications.value, (key) => key === notificationsKey(instanceId));
    clearWhere(notificationsBefore.value, (key) => key === notificationsKey(instanceId));
    clearWhere(notificationsHasMore.value, (key) => key === notificationsKey(instanceId));
    clearWhere(polledNotifications.value, (key) => key === instanceId);
    clearWhere(notificationPollErrors.value, (key) => key === instanceId);
    clearWhere(userStopwatches.value, (key) => key === userStopwatchesKey(instanceId));
    clearWhere(globalSearchResults.value, inScope);
    for (const map of instanceScopedPayloads()) {
      clearWhere(map, inScope);
    }
    repositoriesCache.delete(instanceId);
    myIssuesCache.deleteWhere(inScope);
    myPullRequestsCache.deleteWhere(inScope);
    for (const cache of instanceScopedCaches()) {
      cache.deleteWhere(inScope);
    }
    // Loading/error slots are keyed the same way and would otherwise keep a
    // stale spinner or error for a server the user just replaced.
    clearWhere(loading, inScope);
    clearWhere(errors, inScope);
  }

  /** Reactive payload maps whose keys are all instance-scoped. */
  function instanceScopedPayloads(): Map<string, unknown>[] {
    return [
      repoDetails.value,
      issueDetails.value,
      pullRequestDetails.value,
      repoIssues.value,
      repoPullRequests.value,
      repoBranchCommits.value,
      pullRequestFiles.value,
      pullRequestComments.value,
      pullRequestCommits.value,
      repoContents.value,
      repoRefs.value,
      repoFileSearchResults.value,
      repoFileSearchTruncated.value,
      fileHistories.value,
      repoLabels.value,
      repoAssignees.value,
      repoMilestones.value,
      actionRuns.value,
      actionRunsPage.value,
      actionRunsHasMore.value,
      actionRunTotalCount.value,
      actionRunDetails.value,
      actionRunJobs.value,
      actionRunArtifacts.value,
      actionJobLogs.value,
      issueSubscriptions.value,
      issueTrackedTimes.value,
      issueDependencies.value,
      issueReactions.value,
      commentReactions.value,
    ] as Map<string, unknown>[];
  }

  /** TTL response caches whose keys are all instance-scoped. */
  function instanceScopedCaches(): { deleteWhere(predicate: (key: string) => boolean): void }[] {
    return [
      repoDetailsCache,
      issueDetailCache,
      pullRequestDetailCache,
      pullRequestCommentsCache,
      pullRequestFilesCache,
      pullRequestCommitsCache,
      repoContentsCache,
      repoRefsCache,
      repoBranchCommitsCache,
      repoLabelsCache,
      repoAssigneesCache,
      repoMilestonesCache,
    ];
  }

  /**
   * Handle the host "refresh instances" command: drop the instance-level TTL
   * caches and the payload slots they back, then force-reload the dashboard lists
   * (repositories, my issues, my pull requests) for every known instance.
   * Without dropping the payloads a refresh would leave the stale list on screen
   * while the forced request is in flight. In-flight requests are left alone —
   * the load functions dedupe on their loading keys.
   */
  function refreshInstanceData() {
    repositoriesCache.clear();
    myIssuesCache.clear();
    myPullRequestsCache.clear();
    repositories.value.clear();
    myIssues.value.clear();
    myPullRequests.value.clear();
    for (const instance of instances.value) {
      loadRepositories(instance.id, true);
      loadMyIssues(instance.id, 'open', true);
      loadMyPullRequests(instance.id, 'open', true);
    }
  }

  function loadMyIssues(instanceId: string, state = 'open', force = false) {
    const key = `issues-${instanceId}-${state}`;
    if (!force && myIssuesCache.has(`${instanceId}:${state}`)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getMyIssues', instanceId, state });
  }

  function loadMyPullRequests(instanceId: string, state = 'open', force = false) {
    const key = `pulls-${instanceId}-${state}`;
    if (!force && myPullRequestsCache.has(`${instanceId}:${state}`)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'getMyPullRequests', instanceId, state });
  }

  function loadGlobalSearch(
    instanceId: string,
    scope: 'all' | 'repositories' | 'issues' | 'pullRequests',
    query: string,
    state: string = 'all',
  ) {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    const key = globalSearchKey(instanceId, scope, trimmed, state);
    if (loading.get(key)) {
      return;
    }
    beginLoading(key);
    postMessage({ command: 'globalSearch', instanceId, scope, query: trimmed, state, limit: GLOBAL_SEARCH_LIMIT });
  }

  function setGlobalSearchScope(scope: 'all' | 'repositories' | 'issues' | 'pullRequests') {
    globalSearchActiveScope.value = scope;
  }

  function setGlobalSearchQuery(query: string) {
    globalSearchQuery.value = query;
  }

  function loadNotifications(
    instanceId: string,
    statusTypes: string[] = ['unread', 'pinned'],
    subjectType?: string[],
    before?: string,
  ) {
    const key = notificationsKey(instanceId);
    if (loading.get(key)) {
      // Only a filter reload is worth queueing: it must win over the request in
      // flight, while a dropped "load more" click is harmless (the button is
      // disabled while loading).
      if (!before) {
        pendingNotificationIntents.set(instanceId, { statusTypes, subjectType });
      }
      return;
    }
    beginLoading(key);
    inFlightNotificationArgs.set(instanceId, JSON.stringify({ statusTypes, subjectType }));
    postMessage({
      command: 'getNotifications',
      instanceId,
      statusTypes,
      subjectType,
      limit: NOTIFICATIONS_LIMIT,
      ...(before ? { before } : {}),
    });
  }

  function markNotificationRead(instanceId: string, id: number) {
    postMessage({ command: 'markNotificationRead', instanceId, id });
  }

  function markAllNotificationsRead(instanceId: string) {
    postMessage({ command: 'markAllNotificationsRead', instanceId });
  }

  const unreadNotificationCount = computed(() => {
    let count = 0;
    for (const instance of instances.value) {
      const list = polledNotifications.value.get(instance.id) ?? [];
      count += list.filter((notification) => notification.unread).length;
    }
    return count;
  });

  // Unread count over the notifications the view is actually showing. The
  // poller slot above is only written while notification polling is enabled,
  // so it is empty (and stale for up to a poll interval) when polling is off;
  // the view's own list must drive its actions instead.
  const unreadViewNotificationCount = computed(() => {
    let count = 0;
    for (const list of notifications.value.values()) {
      count += list.filter((notification) => notification.unread).length;
    }
    return count;
  });

  return {
    t,
    locale,
    instances,
    repositories,
    repositoriesCache,
    myIssues,
    myIssuesCache,
    myPullRequests,
    myPullRequestsCache,
    repoDetails,
    issueDetails,
    pullRequestDetails,
    repoIssues,
    repoIssuesFetchedAt,
    repoPullRequests,
    actionRuns,
    actionRunsPage,
    actionRunsHasMore,
    actionRunTotalCount,
    actionRunDetails,
    actionRunJobs,
    actionRunArtifacts,
    actionJobLogs,
    repoBranchCommits,
    pullRequestFiles,
    pullRequestComments,
    pullRequestCommits,
    repoContents,
    repoRefs,
    repoFileSearchResults,
    repoFileSearchTruncated,
    fileHistories,
    globalSearchResults,
    globalSearchActiveScope,
    globalSearchQuery,
    notifications,
    notificationsBefore,
    notificationsHasMore,
    polledNotifications,
    notificationPollErrors,
    unreadNotificationCount,
    unreadViewNotificationCount,
    repoLabels,
    repoAssignees,
    repoMilestones,
    repoDetailsCache,
    repoLabelsCache,
    repoAssigneesCache,
    repoMilestonesCache,
    issueSubscriptions,
    issueTrackedTimes,
    issueDependencies,
    issueReactions,
    commentReactions,
    userStopwatches,
    loading,
    errors,
    debug,
    worktrees,
    worktreeOpenMode,
    worktreeCacheDirectory,
    worktreeCacheDirectoryDefault,
    vscodeVersion,
    supportsMultiDiff,
    dashboardActiveTab,
    linkedRepository,
    linkedRepositories,
    activeLinkedRepository,
    pendingCreatePr,
    pendingNewIssue,
    testConnectionResult,
    saveInstanceResult,
    exportInstancesResult,
    importInstancesResult,
    importPreview,
    lastSavedIssue,
    lastSavedPullRequest,
    lastWorktreeCancelled,
    lastWorktreeError,
    lastDispatchCancelled,
    openExternal,
    openWorktreePath,
    copyToClipboard,
    previewReadme,
    testConnection,
    saveInstance,
    editInstance,
    removeInstance,
    exportInstances,
    copyInstancesToClipboard,
    previewImportInstances,
    confirmImportInstances,
    cancelImportInstances,
    changeLocale,
    changeDebug,
    openRepoDetail,
    loadRepoDetail,
    loadRepoBranchCommits,
    loadRepoContents,
    loadRepoFileSearch,
    loadFileHistory,
    loadRepoRefs,
    createRepoBranch,
    deleteRepoBranch,
    createRepoTag,
    deleteRepoTag,
    createRepoRelease,
    editRepoRelease,
    deleteRepoRelease,
    uploadReleaseAttachment,
    deleteReleaseAttachment,
    showInputBox,
    showConfirm,
    openRepoFile,
    openRepoFileDiff,
    createIssue,
    editIssue,
    toggleIssueState,
    togglePullRequestState,
    updateIssueDueDate,
    updatePullRequestDueDate,
    deleteIssue,
    createIssueComment,
    editIssueComment,
    deleteIssueComment,
    uploadIssueAttachment,
    uploadIssueCommentAttachment,
    deleteIssueAttachment,
    deleteIssueCommentAttachment,
    openIssueDetail,
    loadIssueDetail,
    createPullRequest,
    editPullRequest,
    mergePullRequest,
    revertMergeCommit,
    openPullRequestDetail,
    loadPullRequestDetail,
    loadPullRequestFiles,
    loadPullRequestComments,
    loadPullRequestCommits,
    openPullRequestDiff,
    openSelectedPullRequestDiffs,
    openRepoIssues,
    loadRepoIssues,
    loadRepoLabels,
    loadRepoAssignees,
    loadRepoMilestones,
    loadIssueSubscription,
    changeIssueSubscription,
    loadIssueTrackedTimes,
    loadUserStopwatches,
    startIssueStopwatch,
    stopIssueStopwatch,
    deleteIssueStopwatch,
    addIssueTime,
    resetIssueTime,
    deleteIssueTime,
    loadIssueDependencies,
    createIssueDependency,
    removeIssueDependency,
    loadIssueReactions,
    changeIssueReaction,
    loadCommentReactions,
    changeCommentReaction,
    openRepoPullRequests,
    loadRepoPullRequests,
    consumePendingCreatePr,
    consumePendingNewIssue,
    loadActionRuns,
    openActionRunDetail,
    loadActionRun,
    loadActionRunJobs,
    loadActionRunArtifacts,
    loadActionJobLog,
    dispatchWorkflow,
    cancelActionRun,
    deleteActionRun,
    downloadActionArtifact,
    changeRepoIssuesState,
    changeRepoPullRequestsState,
    loadLinkedRepository,
    selectLinkedRepository,
    openLinkedRepositoryDetail,
    openLinkedRepositoryIssues,
    openLinkedRepositoryPullRequests,
    openPrWorktree,
    startWorkOnIssue,
    removeWorktree,
    changeWorktreeOpenMode,
    setWorktreeCacheDirectory,
    browseWorktreeCacheDirectory,
    setDashboardActiveTab,
    renderMarkdown,
    searchMentions,
    getUserPreview,
    getIssuePreview,
    loadRepositories,
    loadMyIssues,
    loadMyPullRequests,
    loadGlobalSearch,
    setGlobalSearchScope,
    setGlobalSearchQuery,
    loadNotifications,
    markNotificationRead,
    markAllNotificationsRead,
  };
}

type AppState = ReturnType<typeof createAppState>;
let sharedState: AppState | undefined;

export function useAppState() {
  if (!sharedState) {
    sharedState = createAppState();
  }
  return sharedState;
}

export function repoDetailKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}`;
}

export function repoBranchCommitsKey(instanceId: string, owner: string, repo: string, branch: string): string {
  return `${instanceId}:${owner}/${repo}:branch:${branch}`;
}

export function issueFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:issue-form:${index}`;
}

export function issueStateKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:issue-state:${index}`;
}

export function issueDueDateKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:issue-due-date:${index}`;
}

export function pullRequestDueDateKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:pr-due-date:${index}`;
}

export function startWorkKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:start-work:${index}`;
}

export function pullRequestStateKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:pull-state:${index}`;
}

export function issueDetailKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}`;
}

export function issueCommentFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:comment-form`;
}

export function issueCommentEditFormKey(instanceId: string, owner: string, repo: string, commentId: number): string {
  return `${instanceId}:${owner}/${repo}:comment-${commentId}:edit-form`;
}

export function issueCommentDeleteFormKey(instanceId: string, owner: string, repo: string, commentId: number): string {
  return `${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`;
}

export function pullRequestFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:pr-form:${index}`;
}

export function pullRequestMergeFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:merge-form`;
}

export function pullRequestDetailKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}`;
}

export function pullRequestFilesKey(
  instanceId: string,
  owner: string,
  repo: string,
  index: number,
  baseSha?: string,
  headSha?: string,
): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:files:${baseSha ?? ''}:${headSha ?? ''}`;
}

export function pullRequestCommentsKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:comments`;
}

export function pullRequestCommitsKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:commits`;
}

export function repoIssuesKey(instanceId: string, owner: string, repo: string, state: string, query?: string): string {
  const base = `${instanceId}:${owner}/${repo}:issues:${state}`;
  const q = query?.trim();
  return q ? `${base}:q=${q}` : base;
}

export function repoLabelsKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:labels`;
}

export function repoAssigneesKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:assignees`;
}

export function repoMilestonesKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:milestones`;
}

export function issueSubscriptionKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:subscription`;
}

export function issueTrackedTimesKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:tracked-times`;
}

export function userStopwatchesKey(instanceId: string): string {
  return `${instanceId}:user-stopwatches`;
}

export function issueDependenciesKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:dependencies`;
}

export function issueReactionsKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:reactions`;
}

export function commentReactionsKey(instanceId: string, owner: string, repo: string, commentId: number): string {
  return `${instanceId}:${owner}/${repo}:comment-${commentId}:reactions`;
}

export function repoPullRequestsKey(
  instanceId: string,
  owner: string,
  repo: string,
  state: string,
  query?: string,
): string {
  const base = `${instanceId}:${owner}/${repo}:pulls:${state}`;
  const q = query?.trim();
  return q ? `${base}:q=${q}` : base;
}

export function actionRunsKey(instanceId: string, owner: string, repo: string): string {
  // One slot per repo: every page of runs accumulates here in server order.
  return `${instanceId}:${owner}/${repo}:actions`;
}

export function actionRunKey(instanceId: string, owner: string, repo: string, runId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:run-${runId}`;
}

export function actionRunJobsKey(instanceId: string, owner: string, repo: string, runId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:run-${runId}:jobs`;
}

export function actionRunArtifactsKey(instanceId: string, owner: string, repo: string, runId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:run-${runId}:artifacts`;
}

export function actionJobLogKey(instanceId: string, owner: string, repo: string, jobId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:job-${jobId}:log`;
}

export function dispatchWorkflowKey(instanceId: string, owner: string, repo: string, workflowfilename: string): string {
  return `${instanceId}:${owner}/${repo}:actions:dispatch:${workflowfilename}`;
}

export function actionRunCancelKey(instanceId: string, owner: string, repo: string, runId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:run-${runId}:cancel`;
}

export function actionRunDeleteKey(instanceId: string, owner: string, repo: string, runId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:run-${runId}:delete`;
}

export function actionArtifactDownloadKey(instanceId: string, owner: string, repo: string, artifactId: number): string {
  return `${instanceId}:${owner}/${repo}:actions:artifact-${artifactId}:download`;
}

export function repoContentsKey(instanceId: string, owner: string, repo: string, ref: string, path: string) {
  return `${instanceId}:${owner}/${repo}:contents:${ref}:${path}`;
}

export function repoRefsKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:refs`;
}

export function repoFileSearchKey(instanceId: string, owner: string, repo: string, ref: string, query: string): string {
  return `${instanceId}:${owner}/${repo}:file-search:${ref}:${query}`;
}

export function fileHistoryKey(instanceId: string, owner: string, repo: string, path: string, ref: string): string {
  return `${instanceId}:${owner}/${repo}:file-history:${path}:${ref}`;
}

export function globalSearchKey(
  instanceId: string,
  scope: 'all' | 'repositories' | 'issues' | 'pullRequests',
  query: string,
  state: string = 'all',
): string {
  return `${instanceId}:global-search:${scope}:${state}:${query}`;
}

// Server-side caps for single-page lists. The views compare list lengths
// against these to show a "only the first N" truncation hint.
export const GLOBAL_SEARCH_LIMIT = 20;
export const NOTIFICATIONS_LIMIT = 50;
// Page size requested for action runs. A response with fewer runs than this is
// the last page; the host does not echo the limit, so the webview compares
// against its own constant.
export const ACTION_RUNS_PAGE_LIMIT = 30;

export function notificationsKey(instanceId: string): string {
  return `${instanceId}:notifications`;
}

/**
 * Append `incoming` to `existing`, dropping notifications that are already
 * shown (`id` is the thread id and stable across pages). A duplicate can only
 * come from a repeated or out-of-order reply; one copy is better than showing
 * the same thread twice, and a reply that added nothing keeps the old array so
 * the view does not re-render.
 */
export function mergeNotificationPages(
  existing: ForgejoNotification[],
  incoming: ForgejoNotification[],
): ForgejoNotification[] {
  const seen = new Set(existing.map((notification) => notification.id));
  const appended = incoming.filter((notification) => !seen.has(notification.id));
  return appended.length === 0 ? existing : [...existing, ...appended];
}

/**
 * Cursor for the next page: the oldest `updated_at` among the notifications
 * shown, as ISO 8601 (the `before` filter). Timestamps are parsed rather than
 * compared as strings because the API serializes them with the server's UTC
 * offset, which breaks lexicographic ordering. Returns `undefined` when no
 * entry carries a usable timestamp, which disables "load more".
 */
export function oldestNotificationTimestamp(notifications: ForgejoNotification[]): string | undefined {
  let oldest: number | undefined;
  for (const notification of notifications) {
    const updated = notification.updated_at;
    if (typeof updated !== 'string') {
      continue;
    }
    const parsed = Date.parse(updated);
    if (Number.isNaN(parsed)) {
      continue;
    }
    if (oldest === undefined || parsed < oldest) {
      oldest = parsed;
    }
  }
  return oldest === undefined ? undefined : new Date(oldest).toISOString();
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const current = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < Math.max(current.length, required.length); i++) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}
