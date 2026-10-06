import * as vscode from 'vscode';
import { instanceIdFor, instanceNameFor } from '../instanceIdentity';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../logger';
import { ForgejoClient, API_REQUEST_TIMEOUT_MS, invalidateRepoContentCaches } from '../api/client';
import type { ForgejoChangedFile, ForgejoReadmeNotice } from '../api/types';
import { ConfigManager } from '../config';
import type { ExportSettings, ForgejoInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { toPublicInstance } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { getWebviewContent, toInstanceOrigins } from './content';
import type { ReadmeContentProvider } from '../readmeProvider';
import { openReadmePreview } from '../readmeProvider';
import { buildRepoFileUri } from '../repoFileProvider';
import { WorktreeManager, WorktreeInfo, validateCacheDirectory } from '../worktree/worktreeManager';
import { InFlightTasks } from '../worktree/inFlightTasks';
import {
  clearLinkedRepositoryCache,
  cloneRepository,
  createWorktreeFromBranch,
  createWorktreeWithNewBranch,
  deleteBranch,
  detectLinkedRepositories,
  discardStalePrWorktree,
  fetchBranch,
  fetchPullRequestHead,
  findLocalRepo,
  getRefCommitSha,
  hasUsableOriginRemote,
  inspectPrWorktree,
  isCurrentWorkspaceBaseRepo,
  isGitRepository,
  isPathInsideFolder,
  isRevertInProgress,
  listRemotes,
  openWorktree,
  PR_THROWAWAY_BRANCH_PATTERN,
  removeWorktreeAndPrune,
  requiresWorkspaceReplacement,
  resolveRemoteForRepo,
  revertMergeCommit,
  sameRepositoryUrl,
  sanitizeForPath,
} from '../worktree/gitOperations';
import type { StalePrWorktreeInfo } from '../worktree/gitOperations';
import type { HostToWebviewMessage, SettingsSurfaceSnapshot } from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import {
  computeImportTokenConflicts,
  ImportCancelledError,
  readExportDataFromUri,
  stripInstanceTokens,
} from './instanceImport';
import { userFacingErrorMessage } from '../api/errors';
import { getProxyFetch } from '../api/proxy';
import { missingPayloadNotice } from '../prFileSystemProvider';
import { probeServerVersion } from '../api/versionProbe';
import { clearServerVersion, MIN_SUPPORTED_VERSION_TEXT, parseDeclaredServerVersion } from '../api/serverVersion';
import { resolveAttachmentImages } from '../utils/resolveAttachmentImages';
import { redactUrlUserinfo, stripUrlUserinfo, hasUrlUserinfo } from '../utils/redactUrlUserinfo';
import { writeFileAtomically } from '../utils/atomicWrite';
import { resolveLocale } from '../utils/resolveLocale';
import {
  isSafeRepoIdentity,
  isSafeRepoNameSegment,
  isSafeRepoPath,
  parsePrDescriptionRequest,
  parseWebviewPullRequestTarget,
  type PrDescriptionRequestTarget,
} from './repoIdentity';
import type { PullRequestTarget } from './repoIdentity';
import { readWorkflowDispatchInputs } from './workflowDispatchInputs';
import { connectionFailureMessage, isHttpUrl } from './connectionTest';
import { echoedListRequestId } from './listRequestId';
import { OnboardingWebviewPanel } from './onboardingPanel';
import { buildForgejoPrDiffUri } from './diffUri';
import { PullReviewCommentPanel } from '../comments/pullReviewCommentPanel';
import { isStorableAiPreReviewModelSettingValue, listAiPreReviewChatModelChoices } from '../aiPreReviewModels';
import {
  AI_PRE_REVIEW_MODEL_SETTING,
  isAiPreReviewEnabled,
  writeAiPreReviewModelSetting,
} from '../aiPreReviewSettings';
import { isPrDescriptionEnabled, prDescriptionOfferedOnCreateForm } from '../prDescriptionSettings';
import {
  readAiProviderSettings,
  removeAiProvider,
  saveAiProvider,
  testAiProvider,
  writeAiDefaultModel,
  writeAiModelBinding,
  writeAiModelPolicy,
  writeAiProviderSecret,
} from './aiProviderSettings';
import { readSettingsSurface, writeSettingsSurfaceValue } from './settingsSurface';
import { ACTIVE_VIEW_CONTEXT_KEY, parseActiveView } from './activeView';
import { SettingsWebviewPanel, settingsLocale, type WebviewReplySink } from './settingsPanel';
import { AsyncLocalStorage } from 'node:async_hooks';
import { aiProviderDraftTestReport } from '../ai/testProvider';
import { aiProviderSettingsReading } from '../ai/modelSettings';
import {
  applyAiImport,
  buildAiImportPreview,
  configuredAiProviderIds,
  EXPORT_PAYLOAD_VERSION,
  parsedAiProviderConfigs,
  readAiConfigForExport,
  type AiExportReading,
  type AiImportConflictChoices,
  type AiImportPlan,
  type ParsedAiSection,
} from './aiConfigImport';

/**
 * The refusal a save/edit gets for a declared server version that does not
 * parse. One reading of `parseDeclaredServerVersion` serves the form and
 * `ConfigManager` (which repeats the same rule at the storage boundary), so the
 * two can never disagree about what "no declaration" means — and the message
 * names a value in the accepted shape instead of leaving the field unexplained.
 *
 * That example is the supported floor itself, not a literal of its own: a
 * number written here would be a second copy of the fact and would keep
 * offering an old release after the floor moves. It is the same value the
 * Settings form interpolates into its description (`initialState`).
 */
function declaredVersionRejection(): string {
  return vscode.l10n.t(
    'Enter a Forgejo version such as {0}, or leave the field empty to use the automatic version probe.',
    MIN_SUPPORTED_VERSION_TEXT,
  );
}

/**
 * The AI collision strategies an `importInstances` message may carry, coerced from
 * the webview's untrusted payload.
 *
 * Anything that is not one of the three answers is dropped rather than passed on,
 * which leaves the absent-strategy reading in place (`keep`, the direction that
 * changes nothing on the receiving machine). The ids themselves are keys here, not
 * instructions: which providers exist and what they contain comes from the
 * host-side stash, so a forged key can name only an id that already reached the
 * preview.
 */
function sanitizeAiConflictChoices(value: unknown): AiImportConflictChoices {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  const choices: AiImportConflictChoices = {};
  for (const [id, strategy] of Object.entries(value as Record<string, unknown>)) {
    if (strategy === 'rename' || strategy === 'replace' || strategy === 'keep') {
      choices[id] = strategy;
    }
  }
  return choices;
}

/**
 * Load-type webview requests whose handlers reply with a result message the
 * requesting view waits on (spinner → data/error). When the targeted instance
 * was deleted, the handler used to bail out silently on `_findInstance` and
 * the keep-alive view spun forever; the guard in `_handleMessage` answers
 * these requests with an error reply instead. Request/response messages
 * (carrying `_requestId`) are already covered by the `_dispatchMessage`
 * fallback, so they are not listed here.
 */
const LOAD_RESULT_COMMANDS: Record<string, string> = {
  getRepositories: 'repositories',
  getMyIssues: 'myIssues',
  getMyPullRequests: 'myPullRequests',
  globalSearch: 'globalSearchResult',
  getNotifications: 'notifications',
  getRepoDetail: 'repoDetail',
  getRepoBranchCommits: 'repoBranchCommits',
  getIssueDetail: 'issueDetail',
  checkIssueSubscription: 'issueSubscriptionChecked',
  getUserStopwatches: 'userStopwatches',
  getIssueTrackedTimes: 'issueTrackedTimes',
  getIssueDependencies: 'issueDependencies',
  getIssueReactions: 'issueReactions',
  getCommentReactions: 'commentReactions',
  getPullRequestDetail: 'pullRequestDetail',
  getPullRequestFiles: 'pullRequestFiles',
  getPullRequestCommentsAndTimeline: 'pullRequestCommentsAndTimeline',
  getPullRequestCommits: 'pullRequestCommits',
  getRepoIssues: 'repoIssues',
  getRepoLabels: 'repoLabels',
  getRepoAssignees: 'repoAssignees',
  getRepoMilestones: 'repoMilestones',
  getRepoPullRequests: 'repoPullRequests',
  getActionRuns: 'actionRuns',
  getActionRun: 'actionRun',
  getActionRunJobs: 'actionRunJobs',
  getActionRunArtifacts: 'actionRunArtifacts',
  getActionJobLog: 'actionJobLog',
  getWorkflowDispatchInputs: 'workflowDispatchInputs',
  getRepoContents: 'repoContents',
  searchRepoFiles: 'repoFilesSearchResult',
  getFileHistory: 'fileHistory',
  getRepoRefs: 'repoRefs',
};

/**
 * Mutation-type webview requests whose handlers reply with a result message
 * the requesting control waits on (button spinner → success/error). They share
 * the deleted-instance pre-check with LOAD_RESULT_COMMANDS: without an error
 * reply the control's loading state would never clear. The pre-check replies
 * echo the request fields back (minus `command`), which is exactly how the
 * webview routes the result to its loading key.
 */
const MUTATION_RESULT_COMMANDS: Record<string, string> = {
  editIssue: 'issueUpdated',
  deleteIssue: 'issueDeleted',
  editPullRequest: 'pullRequestUpdated',
  mergePullRequest: 'pullRequestMerged',
  revertMergeCommit: 'revertMergeCommitResult',
  editIssueComment: 'issueCommentEdited',
  deleteIssueComment: 'issueCommentDeleted',
  changeIssueSubscription: 'issueSubscriptionChanged',
  changeIssueReaction: 'issueReactionChanged',
  changeCommentReaction: 'commentReactionChanged',
  startIssueStopwatch: 'issueStopwatchChanged',
  stopIssueStopwatch: 'issueStopwatchChanged',
  deleteIssueStopwatch: 'issueStopwatchChanged',
  addIssueTime: 'issueTimeAdded',
  resetIssueTime: 'issueTimeReset',
  deleteIssueTime: 'issueTimeDeleted',
  createIssueDependency: 'issueDependencyChanged',
  removeIssueDependency: 'issueDependencyChanged',
  dispatchWorkflow: 'actionRunDispatched',
  cancelActionRun: 'actionRunCancelled',
  deleteActionRun: 'actionRunDeleted',
  downloadActionArtifact: 'actionArtifactDownloaded',
  editRepoRelease: 'repoReleaseEdited',
  deleteRepoRelease: 'repoReleaseDeleted',
  createRepoBranch: 'repoBranchCreated',
  deleteRepoBranch: 'repoBranchDeleted',
  createRepoTag: 'repoTagCreated',
  deleteRepoTag: 'repoTagDeleted',
};

/**
 * Origin equality with URL-parse failures treated as "different": callers use
 * this to gate sending the stored token, so an unparseable target must fail
 * closed.
 */
function isSameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * True when a URL carries `redactUrlUserinfo`'s mask in its userinfo position
 * (`https://***@host/`, `https://alice:***@host/`).
 *
 * The mask is what `toPublicInstance` sends to a webview for an instance whose
 * stored URL embeds a credential, so a Settings form prefilled from it and
 * posted back carries the mask instead of a URL. Matched only before the first
 * `/`, `?` or `#`, so an ordinary path that happens to contain `***` is not
 * mistaken for a redacted URL.
 */
function hasRedactedUserinfo(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*\*\*\*[^/?#]*@/i.test(url);
}

/**
 * Display label for a merge strategy, matching the webview's strategy picker.
 */
function mergeStrategyLabel(strategy: 'merge' | 'rebase' | 'squash'): string {
  switch (strategy) {
    case 'squash':
      return vscode.l10n.t('Squash and merge');
    case 'rebase':
      return vscode.l10n.t('Rebase and merge');
    default:
      return vscode.l10n.t('Create a merge commit');
  }
}

/**
 * The dashboard's sentence for a README that is not a regular file.
 *
 * `getRepoDetail` answers such an entry with its client-side English sentence in
 * `readme` (that is what the headless MCP tools show) and with the structured
 * `readmeNotice` beside it: which kind the entry is, plus the link target or git
 * URL when the API named one. The dashboard is the localized surface, so it
 * words the notice itself instead of showing the English sentence inside a
 * Chinese UI. `undefined` means the entry is not one of those kinds — a regular
 * file, a withheld payload or an absent README — which leaves the caller's own
 * precedence untouched.
 */
function readmeNoticeText(notice: ForgejoReadmeNotice | undefined): string | undefined {
  if (!notice) {
    return undefined;
  }
  if (notice.kind === 'symlink') {
    return notice.target
      ? vscode.l10n.t(
          'README.md is a symlink to {0}, so Forgejo has no README text to show. Open {0} in the Forgejo web UI to read it.',
          notice.target,
        )
      : vscode.l10n.t(
          'README.md is not a regular file in this repository, so Forgejo has no README text to show. Open it in the Forgejo web UI to read it.',
        );
  }
  return notice.target
    ? vscode.l10n.t(
        'README.md is a submodule whose own repository is at {0}, so this repository has no README text to show. Open the submodule in the Forgejo web UI to read it there.',
        notice.target,
      )
    : vscode.l10n.t(
        'README.md is not a regular file in this repository, so Forgejo has no README text to show. Open it in the Forgejo web UI to read it.',
      );
}

/**
 * Destructive confirmations must name their target: the repository a command
 * acts on is carried by the webview message and every dialog otherwise reads
 * the same generic "Delete this …?" text, so a mis-click can destroy the wrong
 * repository's branch, worktree, or issue. Kept together so a new destructive
 * command reuses the wording instead of inventing another generic prompt.
 */
function confirmInstanceScope(instance: Pick<ForgejoInstance, 'name'>, owner: string, repo: string): string {
  return `${instance.name} (${owner}/${repo})`;
}

/**
 * Validate the repository identity carried by a webview worktree message
 * before it is used. The webview is untrusted and these fields end up in both
 * the API URL and `path.join(cacheDir, 'worktrees', ...)`; `path.join`
 * normalises `..`, so an unvalidated `index` or `repo` could point the later
 * `fs.rm(..., { recursive: true })` / `git worktree add` outside the cache.
 */
function parseWorktreeTarget(message: {
  instanceId?: unknown;
  owner?: unknown;
  repo?: unknown;
  index?: unknown;
}): { instanceId: string; owner: string; repo: string; index: number } | undefined {
  const { instanceId, owner, repo, index } = message;
  if (typeof instanceId !== 'string' || instanceId.length === 0) {
    return undefined;
  }
  if (!isSafeRepoNameSegment(owner) || !isSafeRepoNameSegment(repo)) {
    return undefined;
  }
  if (typeof index !== 'number' || !Number.isInteger(index) || index <= 0) {
    return undefined;
  }
  return { instanceId, owner, repo, index };
}

/**
 * Short, filesystem-safe discriminator for the shared bare-clone cache paths.
 * Derived from the instance id + URL so the same `owner/repo` slug on two
 * instances cannot share one clone; the raw host is not used because it may
 * contain characters that are invalid in a path segment.
 */
export function instanceCacheSuffix(instance: { id: string; url: string }): string {
  return crypto.createHash('sha256').update(`${instance.id}|${instance.url}`).digest('hex').slice(0, 8);
}

/**
 * The URL the bare cache clone is fetched from.
 *
 * The instance URL is *used* here, not displayed: `git clone --bare` receives it
 * in a child process's argv, writes it into the clone's `remote.origin.url`
 * (plaintext on disk), and quotes it back in its own failure message, which
 * reaches the webview error and the log. So the userinfo is stripped, and the
 * trailing slashes with it — `https://host//owner/repo.git` makes git/Forgejo
 * answer a redirect or 404 the user cannot correct from the UI.
 *
 * Authentication does not go through this URL: it belongs to the
 * authenticated-remote path, exactly as `cloneRepository`'s `authEnv` passes the
 * token through git's environment instead of embedding it.
 */
export function worktreeCloneUrl(instance: Pick<ForgejoInstance, 'url'>, owner: string, repo: string): string {
  return `${stripUrlUserinfo(instance.url).replace(/\/+$/, '')}/${owner}/${repo}.git`;
}

/**
 * Defense in depth for every worktree path derived from a request: the caller
 * later deletes that directory recursively (`fs.rm(..., { recursive: true })`
 * or `git worktree remove --force`), so a path that escapes the worktree cache
 * must never be used, whatever produced it.
 */
function assertInsideWorktreeCache(worktreesDir: string, worktreePath: string): void {
  if (!isPathInsideFolder(worktreesDir, worktreePath)) {
    throw new Error(`Refusing a worktree path outside the worktree cache: ${worktreePath}`);
  }
}

/**
 * Session-level cache of proxied avatar fetches (same-origin URLs only; other
 * URLs are returned unchanged and never reach the cache). The key is the
 * absolute URL alone: same-origin content is identical for every instance on
 * that origin. Values are promises so concurrent resolutions of the same URL
 * share one fetch. Entries hold no sensitive data (public avatar images keyed
 * by URL), and a removed or edited instance's entries simply stop being hit and
 * age out, so instance changes need no explicit cache invalidation.
 *
 * Bounded two ways, because bounding entries alone does not bound memory: a
 * data URL is base64 and can be hundreds of kilobytes, so 100 of them is tens
 * of megabytes held for the life of the window. The sibling repository-contents
 * memo in `api/client.ts` carries a byte budget for the same reason; this cache
 * keeps its entry cap and adds the byte cap, plus a finite TTL for every
 * entry — successes included, so a session that stays open for days cannot
 * accumulate payloads whose URL was never requested again.
 *
 * A cache hit still returns the stored promise, and eviction is LRU: entries
 * are re-inserted on every hit, so the oldest unused avatar goes first.
 */
const MAX_RESOLVED_AVATARS = 100;
/**
 * Byte budget for the resolved-avatar cache, measured on the data URLs it
 * stores. A Forgejo avatar is a few kilobytes, so this holds roughly a hundred
 * full-size images while keeping the worst case bounded.
 */
export const AVATAR_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Hard cap for one avatar fetch, applied before and during the body read: a
 * data URL is ~4/3 of the bytes fetched, and a handful of multi-megabyte
 * "avatars" (a malicious or misconfigured server can answer any size) would
 * otherwise be buffered whole and then pinned in the cache above.
 */
export const AVATAR_FETCH_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_FAILURE_TTL_MS = 60_000;
/**
 * Successes are content-addressed by URL, but the entry still expires: an
 * avatar URL can be reused by a re-uploaded image, and a finite TTL means a
 * long-lived window cannot pin megabytes of base64 forever.
 */
const AVATAR_SUCCESS_TTL_MS = 30 * 60_000;

interface ResolvedAvatarEntry {
  promise: Promise<string | null>;
  /**
   * Set once the promise settles: the failure TTL for `null`, the success TTL
   * otherwise. An entry that is still in flight stays at `Infinity` — the fetch
   * itself is bounded by `API_REQUEST_TIMEOUT_MS`.
   */
  expiresAt: number;
  /** Serialized size of the resolved data URL; 0 until the promise settles. */
  bytes: number;
}

const resolvedAvatarCache = new Map<string, ResolvedAvatarEntry>();
/**
 * Running total of `bytes` over `resolvedAvatarCache`, maintained on settle, on
 * eviction and on expiry so the budget cannot drift from the map it measures.
 */
let resolvedAvatarCacheBytes = 0;

function getCachedAvatar(url: string): Promise<string | null> | undefined {
  const entry = resolvedAvatarCache.get(url);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    resolvedAvatarCache.delete(url);
    resolvedAvatarCacheBytes -= entry.bytes;
    return undefined;
  }
  // Refresh recency: re-insert so frequently used avatars are evicted last.
  resolvedAvatarCache.delete(url);
  resolvedAvatarCache.set(url, entry);
  return entry.promise;
}

/**
 * Drops the least recently used entries — never the one that just settled —
 * until the byte budget holds again, so a single avatar larger than the budget
 * still leaves the cache with that avatar rather than an empty map.
 */
function enforceAvatarByteBudget(keepUrl: string): void {
  if (resolvedAvatarCacheBytes <= AVATAR_CACHE_MAX_BYTES) {
    return;
  }
  for (const key of resolvedAvatarCache.keys()) {
    if (resolvedAvatarCacheBytes <= AVATAR_CACHE_MAX_BYTES) {
      return;
    }
    if (key === keepUrl) {
      continue;
    }
    const evicted = resolvedAvatarCache.get(key);
    resolvedAvatarCache.delete(key);
    resolvedAvatarCacheBytes -= evicted?.bytes ?? 0;
  }
}

function cacheResolvedAvatar(url: string, promise: Promise<string | null>): void {
  if (!resolvedAvatarCache.has(url) && resolvedAvatarCache.size >= MAX_RESOLVED_AVATARS) {
    // Map iteration order is insertion order: the first key is the oldest.
    const oldest = resolvedAvatarCache.keys().next().value;
    if (oldest !== undefined) {
      const evicted = resolvedAvatarCache.get(oldest);
      resolvedAvatarCache.delete(oldest);
      resolvedAvatarCacheBytes -= evicted?.bytes ?? 0;
    }
  }
  const entry: ResolvedAvatarEntry = { promise, expiresAt: Number.POSITIVE_INFINITY, bytes: 0 };
  void promise.then((dataUrl) => {
    // The entry may have been evicted (or replaced) while the fetch was in
    // flight; only a live entry may contribute to the running total.
    if (resolvedAvatarCache.get(url) !== entry) {
      return;
    }
    if (dataUrl === null) {
      entry.expiresAt = Date.now() + AVATAR_FAILURE_TTL_MS;
      return;
    }
    entry.expiresAt = Date.now() + AVATAR_SUCCESS_TTL_MS;
    entry.bytes = Buffer.byteLength(dataUrl);
    resolvedAvatarCacheBytes += entry.bytes;
    enforceAvatarByteBudget(url);
  });
  resolvedAvatarCache.set(url, entry);
}

/** Bytes the avatar cache currently holds. Exported for tests. */
export function resolvedAvatarCacheBytesForTest(): number {
  return resolvedAvatarCacheBytes;
}

/** Clear the session-level avatar cache. Exported for tests. */
export function clearResolvedAvatarCache(): void {
  resolvedAvatarCache.clear();
  resolvedAvatarCacheBytes = 0;
}

export class ForgejoToolkitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'forgejoToolkitView';

  /** Cap for the pre-mount message queue (see `_postOrQueue`). */
  private static readonly MAX_PENDING_MESSAGES = 50;

  /** Invoked after a pull request is created, merged, or closed through the webview. */
  public onPullRequestsChanged: (() => void) | undefined;

  private _view?: vscode.WebviewView;
  private _pendingMessages: HostToWebviewMessage[] = [];
  /**
   * The view the sidebar last reported (`setActiveView`), which the view-title
   * refresh items are gated on.
   *
   * It is the report, not a guess: VS Code cannot see the sidebar's route, so
   * the webview — the only side that knows — names it, and the host stores the
   * answer under `ACTIVE_VIEW_CONTEXT_KEY`. `undefined` means "no report", which
   * hides every item: an item that fired before the webview had reported could
   * refresh a page the host cannot name.
   */
  private _reportedActiveView: string | undefined;
  /** Request ids currently being handled; a reply removes the id (see `_reply`). */
  private readonly _unansweredRequests = new Set<string>();
  /**
   * The same bookkeeping for the settings tab, kept apart from the sidebar's.
   *
   * The two surfaces generate their request ids from the same composable, so
   * `list-repos-1` can be in flight in both at once. One shared set would let a
   * reply to one surface cancel the other's fallback, and the surface whose
   * handler bailed out silently would then spin forever (see `_dispatchMessage`).
   */
  private readonly _unansweredSettingsRequests = new Set<string>();
  /**
   * Which webview the message being handled came from, for the duration of that
   * handler.
   *
   * A handler's replies are deep inside the shared dispatcher (`_handleMessage`
   * and everything it calls) and cannot be told which surface asked, so the
   * surface travels with the call instead: the settings panel runs its dispatch
   * inside `AsyncLocalStorage.run`, `_reply` reads the channel here, and every
   * reply — including the ones posted after an `await` — lands in the webview
   * that asked. Messages that are not a reply at all (a poller toast, a
   * configuration-change push) have no channel and keep going to the sidebar,
   * exactly as before.
   */
  private readonly _replySink = new AsyncLocalStorage<WebviewReplySink>();
  private readonly _worktreeManager: WorktreeManager;
  /** Guards against concurrent openPrWorktree runs for the same PR (double-click). */
  private readonly _worktreeInFlight = new InFlightTasks();
  /** Guards against concurrent merge/revert mutations for the same PR (double-click). */
  private readonly _prMutationInFlight = new InFlightTasks();
  /**
   * Dedupes concurrent bare clones into the same cache path: two PRs of the
   * same repository opened at once would otherwise race `git clone --bare`
   * into one directory (the later clone fails).
   */
  private readonly _bareCloneInFlight = new InFlightTasks();
  /**
   * Full instance entries (tokens included) from the latest import preview,
   * kept host-side so token values never cross into the webview. Single slot:
   * a new preview overwrites it, and a confirmed or cancelled import — or the
   * view's disposal — clears it. The `importInstances` confirmation rehydrates
   * selected entries by id.
   */
  private _pendingImportInstances: ForgejoInstance[] | undefined;
  /**
   * The parsed `ai` section (credentials included) of the file the latest import
   * preview read. It is held for the same reason the instance stash is: an
   * encrypted file's API keys and header values must not cross into the webview
   * even to be confirmed, so the preview sends only the non-secret reading and the
   * confirmation rehydrates this. Cleared on confirm, cancel and disposal, together
   * with the instance stash.
   */
  private _pendingImportAi: ParsedAiSection | undefined;
  /**
   * The AI pre-review run, handed over by `registerAiPreReviewCommand` rather
   * than imported.
   *
   * The dependency cannot point the other way: `src/aiPreReview.ts` imports this
   * module (it opens the confirmation panel and writes the drafts through the
   * provider), so a static import here would close a cycle. A callback also keeps
   * the flow in one place — the provider validates what a webview sent and then
   * calls exactly the function the `editor/title` button calls, so the two
   * entries cannot drift apart.
   */
  private _aiPreReviewRunner: ((target: PullRequestTarget) => void) | undefined;

  /**
   * The function the create-pull-request form's "generate a description" action
   * runs, registered by `src/prDescription.ts` for the same reason
   * `_aiPreReviewRunner` is a callback: the run owns the model, the consent
   * question and the prompt, and this provider owns only the webview message. Its
   * result is the text the form puts into its body field — nothing here can create
   * or submit a pull request, because all this callback returns is a string.
   */
  private _prDescriptionRunner:
    | ((target: {
        instanceId: string;
        owner: string;
        repo: string;
        base: string;
        head: string;
        title?: string;
      }) => Promise<{ kind: 'ok'; description: string } | { kind: 'cancelled' } | { kind: 'failed'; error: string }>)
    | undefined;

  constructor(
    private readonly _context: vscode.ExtensionContext,
    private readonly _extensionUri: vscode.Uri,
    private readonly _config: ConfigManager,
    private readonly _readmeProvider: ReadmeContentProvider,
    worktreeManager?: WorktreeManager,
  ) {
    this._worktreeManager =
      worktreeManager ??
      new WorktreeManager(
        _context,
        () => this._config.getWorktreeCacheDirectory(),
        () => this._config.getDefaultWorktreeCacheDirectory(),
      );

    this._context.subscriptions.push(
      this._config.onInstancesChanged(() => {
        this._sendInstances();
        // Removing an instance forgets its worktree records (their checkouts
        // stay on disk), and the Settings list renders whatever the last
        // `worktreesList` reply carried. Re-pushing it here is what drops those
        // rows: a row left on screen would otherwise reach `removeWorktree`
        // with no record behind it.
        this._sendWorktrees();
        this._refreshWebviewInstanceOrigins();
        // The onboarding panel's save/remove paths change the instance set
        // without running the detection this provider's own handlers perform;
        // detecting here converges both entry points. Debounced like the
        // active-editor trigger (the sidebar handlers also detect directly),
        // and the scan cache keys on the instance id/url list, so an add/remove
        // misses the cache on its own while a token-only change keeps it.
        this._scheduleLinkedRepositoryDetect();
      }),
    );
    this._context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._detectAndSendLinkedRepository()),
      // In multi-repository workspaces the linked repository follows the
      // active editor; re-resolve when it changes (debounced).
      vscode.window.onDidChangeActiveTextEditor(() => this._scheduleLinkedRepositoryDetect()),
      // `forgejoToolkit.locale` can also be changed from the Settings editor,
      // while the in-panel picker posts `setLocale` itself. Without this the open
      // view keeps the language it was rendered with and the title never follows
      // the setting.
      vscode.workspace.onDidChangeConfiguration((event) => {
        // The AI pre-review switch is read by the dashboard for one thing only:
        // whether to offer its button. It is normally changed in VS Code's own
        // Settings UI, which this webview never sees, so without this push the
        // button would keep the state it was rendered with until the view
        // happened to reload. The run re-checks the setting itself, so this
        // message can only show or hide an affordance.
        if (event.affectsConfiguration('forgejoToolkit.aiPreReview')) {
          this._reply('setAiPreReview', { aiPreReview: isAiPreReviewEnabled() });
        }
        // The PR-description controls' own switches, pushed for the same reason and
        // with the same limit: a stale pair of booleans can only hide or show a
        // button. The **scope** is watched as well as the feature switch, because
        // the create form's share of that answer depends on it: a stated
        // `commits-and-diff` is honourable only where a pull request exists, and
        // without this the create form would keep offering a control whose only
        // outcome is the run's refusal.
        if (
          event.affectsConfiguration('forgejoToolkit.prDescription') ||
          event.affectsConfiguration('forgejoToolkit.prDescriptionPromptScope')
        ) {
          this._reply('setPrDescription', {
            prDescription: isPrDescriptionEnabled(),
            prDescriptionCreateForm: prDescriptionOfferedOnCreateForm(),
          });
        }
        // The AI endpoint keys are listened to here for the same reason as the
        // switch above, and they are the five the settings page renders rather
        // than reads into a field of its own: `aiProviders` (the endpoint list),
        // `aiModelBindings` (which feature uses which endpoint and model),
        // `aiDefaultProvider` / `aiDefaultModel` (the default destination),
        // `aiTransport` and `aiModelRequestTimeoutMs`. A hand edit of any of them
        // in VS Code's own settings editor leaves an open page on the snapshot it
        // read when it mounted (`Settings.vue` re-reads only then and on a
        // visibility change) — the same staleness the import path had until it
        // pushed. They belong **together** because that snapshot is one message: it
        // answers "which endpoints exist, where does each feature go and under
        // which policy", so pushing it for one of them without the others would
        // trade one stale control for another. `_pushAiProviderSettings` re-reads
        // all of them from the host, so this is the page being handed the truth
        // rather than a value from this event. The global AI switch and the
        // per-feature switches are the page's own settings surface
        // (`forgejoToolkit.aiEnabled`, `aiPreReview`, `prDescription`), which is
        // pushed above.
        if (
          event.affectsConfiguration('forgejoToolkit.aiProviders') ||
          event.affectsConfiguration('forgejoToolkit.aiModelBindings') ||
          event.affectsConfiguration('forgejoToolkit.aiDefaultProvider') ||
          event.affectsConfiguration('forgejoToolkit.aiDefaultModel') ||
          event.affectsConfiguration('forgejoToolkit.aiTransport') ||
          event.affectsConfiguration('forgejoToolkit.aiModelRequestTimeoutMs')
        ) {
          void this._pushAiProviderSettings();
          // The settings tab renders the same five keys and reads them from the
          // host; the push above goes to the sidebar, which no longer renders
          // them, so the open tab is told to re-read rather than being left on the
          // snapshot it mounted with.
          SettingsWebviewPanel.notifySettingsChanged();
        }
        if (!event.affectsConfiguration('forgejoToolkit.locale')) {
          return;
        }
        const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
        const locale = resolveLocale(configured);
        this._reply('setLocale', { locale });
        this._updateViewTitle(locale);
        // The sidebar is not the only webview that renders in this language: an
        // open onboarding wizard or review-comment editor keeps the language it
        // was created with unless the host pushes the change into it too.
        OnboardingWebviewPanel.notifyLocaleChanged(locale);
        PullReviewCommentPanel.notifyLocaleChanged(locale);
        // And the settings tab, which is the surface where the language is
        // actually chosen: its own picker writes the setting and gets the echo
        // through the reply channel, but a change made in VS Code's settings
        // editor has to be pushed the same way the wizard's is.
        SettingsWebviewPanel.notifyLocaleChanged(locale);
      }),
      {
        dispose: () => {
          // Both timers run a git scan and a `setContext` on a disposed host if
          // they are left pending; the cold-start one fires 2 s after
          // activation, which is well within a short-lived or reloaded session.
          clearTimeout(this._linkedRepoDetectTimer);
          clearTimeout(this._initialDetectTimer);
        },
      },
    );

    // Cold-start detection: the user may never open a file or the sidebar,
    // but the SCM publish button (forgejoToolkit.hasUnpublishedRepo) must
    // still appear. Delayed so activation stays fast; unref'd so tests are
    // not held open. Failures are swallowed inside
    // _detectAndSendLinkedRepository, so this never becomes an unhandled
    // rejection.
    this._initialDetectTimer = setTimeout(() => {
      void this._detectAndSendLinkedRepository();
    }, 2000);
    this._initialDetectTimer.unref?.();
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;
    // A freshly created webview has reported nothing yet, and the page it boots
    // on is not the one the previous instance left behind: the refresh items
    // stay hidden until this webview names its own route (see `_handleMessage`'s
    // `setActiveView` case).
    this._forgetActiveView();

    // Codicons ship inside the webview bundle (imported in webview/src/main.ts
    // with the font inlined), so there is nothing to resolve from node_modules
    // here — which would also fail in a packaged install where node_modules is
    // excluded.
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'out', 'webview')],
    };

    webviewView.webview.html = this._renderWebviewHtml(webviewView.webview);

    webviewView.onDidDispose(() => {
      if (this._view === webviewView) {
        this._view = undefined;
      }
      // The view that named its route is gone; leaving the key at its last value
      // would keep a refresh item on screen for a webview that no longer exists.
      this._forgetActiveView();
      // The import preview's stash holds the file's tokens in plaintext, and the
      // webview that could still confirm it is gone: without this it would
      // outlive the panel until the next preview overwrote it or the window
      // closed. The AI stash (which can hold the file's decrypted credentials)
      // goes with it, for the same reason.
      this._pendingImportInstances = undefined;
      this._pendingImportAi = undefined;
    });

    webviewView.webview.onDidReceiveMessage(
      (message) => {
        void this._dispatchMessage(message);
      },
      undefined,
      [],
    );

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        this._sendInstances();
        this._detectAndSendLinkedRepository();
      }
    });
  }

  /**
   * Serialized instance-origin set baked into the last generated HTML. The
   * CSP img-src allowlists instance origins, so the HTML must be regenerated
   * when that set changes.
   */
  private _webviewInstanceOriginsKey: string | undefined;

  private _renderWebviewHtml(webview: vscode.Webview): string {
    const instanceUrls = this._config.getInstances().map((i) => i.url);
    this._webviewInstanceOriginsKey = JSON.stringify(toInstanceOrigins(instanceUrls).sort());
    return getWebviewContent(webview, this._extensionUri.fsPath, { instanceUrls });
  }

  /**
   * The HTML — and with it the CSP instance-origin allowlist — is generated
   * once at resolve time; an instance added afterwards would have its direct
   * images blocked until a reload. Regenerate when the origin set changes.
   * Reloading loses transient webview state, which is acceptable: instance
   * changes are rare and the webview re-requests its initial state. There is
   * no loop: resetting html does not fire another instances change.
   */
  private _refreshWebviewInstanceOrigins(): void {
    if (!this._view) {
      return;
    }
    const key = JSON.stringify(toInstanceOrigins(this._config.getInstances().map((i) => i.url)).sort());
    if (key !== this._webviewInstanceOriginsKey) {
      this._view.webview.html = this._renderWebviewHtml(this._view.webview);
      // That reload boots a new page, which starts on its own first route rather
      // than the one it left behind: until it reports (see `_handleMessage`'s
      // `setActiveView`), the host cannot name a view and hides every refresh
      // item instead of offering the previous page's.
      this._forgetActiveView();
    }
  }

  /**
   * Fallback dispatch wrapper for webview messages. Many handlers bail out
   * early (unknown instance, invalid payload) without sending a reply; for
   * request/response messages (carrying `_requestId`) that leaves the webview
   * promise pending forever. This wrapper tracks whether a reply with the
   * same `_requestId` was sent (see `_reply`) and emits a generic
   * `requestError` reply when the handler finished — or threw — without one.
   */
  private async _dispatchMessage(message: any): Promise<void> {
    if (!message || typeof message !== 'object' || typeof message.command !== 'string') {
      logger.error('Ignoring malformed message from webview');
      return;
    }
    // Repository identity from the webview is interpolated verbatim into API
    // paths (`/repos/${owner}/${repo}/…`), where the URL parser resolves dot
    // segments and splits on `?`/`#`: an unvalidated value turns a
    // repository-scoped command into an arbitrary same-origin request. Every
    // command carrying this pair is rejected here, before any handler runs.
    if (!isSafeRepoIdentity(message.owner, message.repo)) {
      logger.error(
        `Ignoring webview message "${message.command}" with an unsafe owner/repo identity: ${String(message.owner)}/${String(message.repo)}`,
      );
      // startWorkOnIssue is a plain (requestId-less) message whose result is
      // routed by the coordinates it carries, and the webview sets its
      // start-work spinner before posting. Answering it with `requestError`
      // (which it cannot route) or not at all would leave that spinner running
      // forever, so it gets the same startWorkResult shape as the handler's
      // invalid-payload path.
      if (message.command === 'startWorkOnIssue') {
        // The identity fields are echoed exactly as they arrived (the webview
        // builds its loading key by string interpolation of what it posted), so
        // the reply reaches the spinner it is meant to clear even for a value
        // this guard rejected. The request's `command` is stripped so it cannot
        // overwrite the reply's.
        const { command: _command, ...echoedIdentity } = message as Record<string, unknown>;
        this._reply('startWorkResult', {
          ...echoedIdentity,
          error: vscode.l10n.t('The request could not be completed'),
        } as Parameters<typeof this._reply<'startWorkResult'>>[1]);
        return;
      }
      // openPrWorktree is the same kind of plain (requestId-less) message, and
      // the PR view spins until a worktreeOpened/worktreeCancelled/
      // worktreeError reply arrives. The identity fields are echoed when they
      // are strings so the reply routes to the view that asked (the webview
      // builds that key from whatever it sent).
      if (message.command === 'openPrWorktree') {
        this._reply('worktreeError', {
          error: vscode.l10n.t('The request could not be completed'),
          operation: 'open',
          instanceId: typeof message.instanceId === 'string' ? message.instanceId : undefined,
          owner: typeof message.owner === 'string' ? message.owner : undefined,
          repo: typeof message.repo === 'string' ? message.repo : undefined,
          index: typeof message.index === 'number' ? message.index : undefined,
        });
        return;
      }
      const requestId = typeof message._requestId === 'string' ? (message._requestId as string) : undefined;
      if (requestId) {
        this._reply('requestError', {
          _requestId: requestId,
          error: vscode.l10n.t('The request could not be completed'),
        });
        return;
      }
      // RequestId-less loaders (getRepoContents, getFileHistory, …) set their
      // spinner before posting and clear it only on their own result message, so
      // returning silently leaves it spinning forever. Reject through the same
      // reply contract as the handler's invalid-payload path.
      const resultCommand = LOAD_RESULT_COMMANDS[message.command] ?? MUTATION_RESULT_COMMANDS[message.command];
      if (resultCommand) {
        this._replyResultShapedError(message, resultCommand, vscode.l10n.t('The request could not be completed'));
      }
      return;
    }
    const requestId = typeof message._requestId === 'string' ? (message._requestId as string) : undefined;
    const unanswered = this._unansweredForCurrentSurface();
    if (requestId) {
      unanswered.add(requestId);
    }
    try {
      await this._handleMessage(message);
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`Error handling webview message "${message.command}": ${err}`);
    } finally {
      if (requestId && unanswered.has(requestId)) {
        unanswered.delete(requestId);
        logger.error(`Handler for "${message.command}" ended without replying to request ${requestId}`);
        this._reply('requestError', {
          _requestId: requestId,
          error: vscode.l10n.t('The request could not be completed'),
        });
      }
    }
  }

  /**
   * The pending-request set of the surface whose message is being handled: the
   * settings tab while its own dispatch is on the stack, the sidebar otherwise
   * (see `_replySink`).
   */
  private _unansweredForCurrentSurface(): Set<string> {
    return this._replySink.getStore() ? this._unansweredSettingsRequests : this._unansweredRequests;
  }

  /**
   * Answers a requestId-less, result-shaped webview message with an error reply
   * that echoes the request fields (minus `command`) — which is how the webview
   * routes the result to its loading key. Used when a request is rejected before
   * any handler runs (a deleted instance, a forged owner/repo), where returning
   * silently would leave the view spinning forever.
   */
  private _replyResultShapedError(message: any, resultCommand: string, error: string): void {
    const { command: _command, ...rest } = message as Record<string, unknown>;
    // editIssue/editPullRequest route close/reopen toggles and inline due-date
    // saves to their own loading keys via these flags, which the handlers derive
    // from `data` on the normal path.
    const editData = rest.data as { state_toggle?: unknown; due_date_update?: unknown } | undefined;
    const routingFlags =
      message.command === 'editIssue' || message.command === 'editPullRequest'
        ? {
            ...(editData?.state_toggle ? { stateToggle: true } : {}),
            ...(editData?.due_date_update ? { dueDateUpdate: true } : {}),
          }
        : {};
    (this._reply as (command: string, data: Record<string, unknown>) => void)(resultCommand, {
      ...rest,
      ...routingFlags,
      error,
    });
  }

  private async _handleMessage(message: any): Promise<void> {
    logger.debug(`Received message from webview: ${message.command}`);
    // Instance was deleted while a keep-alive view still targets it: answer
    // load and mutation requests with an error reply so the view shows the
    // error instead of spinning forever (the handlers themselves bail out
    // silently). The reply echoes the request fields, which is how the
    // webview routes it to the right loading key.
    //
    // The guard fires on a missing/empty `instanceId` too, not only on an
    // unknown one: a malformed message otherwise reaches the handler, whose
    // `_findInstance(undefined)` lookup misses and returns without replying —
    // the webview's loading state would never clear. Echoing the request
    // fields stays safe there as well: with no `instanceId` on the request the
    // reply simply carries none.
    const resultCommand = LOAD_RESULT_COMMANDS[message.command] ?? MUTATION_RESULT_COMMANDS[message.command];
    if (resultCommand) {
      const instanceId =
        typeof message.instanceId === 'string' && message.instanceId.length > 0 ? message.instanceId : undefined;
      if (instanceId === undefined || !this._findInstance(instanceId)) {
        logger.error(`${message.command} failed: instance not found: ${String(message.instanceId)}`);
        this._replyResultShapedError(
          message,
          resultCommand,
          instanceId === undefined
            ? vscode.l10n.t('The request could not be completed')
            : vscode.l10n.t('The Forgejo instance is no longer configured'),
        );
        return;
      }
    }
    switch (message.command) {
      case 'getInitialState': {
        const configured = vscode.workspace.getConfiguration('forgejoToolkit').get<'en' | 'zh' | undefined>('locale');
        const locale: 'en' | 'zh' = resolveLocale(configured);
        const debug = vscode.workspace.getConfiguration('forgejoToolkit').get<boolean>('debug', false);
        const directory = this._config.getWorktreeCacheDirectory() ?? '';
        const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
        this._updateViewTitle(locale);
        this._reply('initialState', {
          instances: this._config.getInstances().map(toPublicInstance),
          locale,
          debug,
          // The dashboard's own gate for the AI pre-review button. Read here and
          // pushed into the view the same way `debug` is, because the webview
          // cannot see extension configuration: it renders a switch it was told
          // about, and the run re-checks the setting itself so a stale boolean
          // can only hide or show a button, never allow a run.
          aiPreReview: isAiPreReviewEnabled(),
          // The create-pull-request form's own gate for its "Generate description"
          // control, read and pushed exactly like the AI pre-review switch above:
          // the form hides an action whose only outcome would be the run's own
          // refusal, and the run re-checks the setting either way.
          prDescription: isPrDescriptionEnabled(),
          // The **create** form's gate, which is a different fact: one of the
          // stated prompt scopes drafts from the pull request's own diff and
          // therefore needs a pull request that already exists, so the create form
          // does not offer the control while that scope is configured. The host
          // derives it because only the host can read configuration; the run
          // refuses by name either way, so a stale value can only hide or show a
          // button.
          prDescriptionCreateForm: prDescriptionOfferedOnCreateForm(),
          // The floor the host's own version notices use, so the Settings
          // form's "Server version" example names the release this build
          // actually supports instead of a number written into a translation
          // file that would keep showing it after the floor moves.
          minSupportedServerVersion: MIN_SUPPORTED_VERSION_TEXT,
          worktrees: this._worktreeManager.getWorktrees(),
          worktreeOpenMode: this._config.getWorktreeOpenMode(),
          worktreeCacheDirectory: directory,
          worktreeCacheDirectoryDefault: defaultDirectory,
        });
        this._detectAndSendLinkedRepository();
        // The queue holds messages for the **sidebar**, which could not be
        // delivered because its webview had never been resolved, so only the
        // sidebar's own `getInitialState` may drain it. The settings tab asks the
        // same question on every mount and on every showing, and draining the
        // queue there would drop the sidebar's pending messages into a `_view`
        // that does not exist yet — losing them for good.
        if (!this._replySink.getStore() && this._pendingMessages.length > 0) {
          const pending = this._pendingMessages.splice(0);
          for (const message of pending) {
            this._view?.webview.postMessage(message);
          }
        }
        return;
      }
      case 'getLinkedRepository': {
        this._detectAndSendLinkedRepository();
        return;
      }

      case 'setActiveView': {
        // The sidebar tells the host which of its routes is on screen, because
        // that is the only side that knows: the view-title refresh items are
        // contributed by the host and their `when` clauses can only test a
        // context key. The value is validated rather than trusted (the webview
        // is untrusted), and anything unrecognised hides every item.
        this._reportedActiveView = parseActiveView(message.view);
        this._applyActiveViewContext();
        return;
      }

      case 'testConnection': {
        const { url, token, instanceId } = message;
        if (typeof url !== 'string' || typeof token !== 'string') {
          this._reply('testConnectionResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // See isHttpUrl: the target is chosen by the webview, so only web URLs
        // may be reached. The setup wizard stays free to test any instance.
        if (!isHttpUrl(url)) {
          logger.error(`testConnection rejected a non-http(s) URL`);
          this._reply('testConnectionResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // A URL carrying credentials cannot be fetched at all (Node's `fetch`
        // refuses to build a request from it), and the stored form of this URL
        // is refused by ConfigManager.addInstance for the same reason. Refused
        // here so the user gets the storage reason instead of a "cannot connect"
        // message that blames the instance.
        if (hasUrlUserinfo(url)) {
          logger.error(`testConnection rejected an instance URL that embeds credentials`);
          this._reply('testConnectionResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // When editing an instance the token field is left empty to keep the
        // stored token (tokens are never sent to the webview); fall back to it
        // so testing the connection of a private instance does not fail. The
        // fallback is restricted to the instance's own origin — otherwise a
        // compromised webview could exfiltrate the token to any URL.
        let effectiveToken = token;
        if (!effectiveToken && typeof instanceId === 'string') {
          const instance = this._findInstance(instanceId);
          if (instance && isSameOrigin(url, instance.url)) {
            effectiveToken = instance.token;
          }
        }
        try {
          const client = new ForgejoClient(url, effectiveToken, logger);
          const user = await client.getCurrentUser();
          // Refresh the cached server version used by the feature gates.
          void probeServerVersion(url, effectiveToken, logger);
          this._reply('testConnectionResult', { success: true, username: user.login });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`testConnection failed: ${err}`);
          // Transport/HTTP failures reply with a status-only message: the raw
          // response body is authored by the remote server and must not be
          // reflected into the webview (see connectionFailureMessage).
          this._reply('testConnectionResult', { success: false, error: connectionFailureMessage(error) });
        }
        return;
      }
      case 'saveInstance': {
        const { url, token, syncApiUrlsToInstanceUrl, declaredServerVersion } = message;
        if (typeof url !== 'string' || typeof token !== 'string') {
          this._reply('saveInstanceResult', { success: false, error: vscode.l10n.t('Invalid input') });
          return;
        }
        // The URL comes from the webview: only http(s) may be stored (see
        // isHttpUrl). A non-HTTP URL would fail at the transport layer anyway,
        // but it is rendered as a link and can reach openExternal, so the
        // scheme is refused before it is persisted. The setup wizard applies
        // the same check before calling this message.
        if (!isHttpUrl(url)) {
          this._reply('saveInstanceResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // A credential embedded as userinfo is refused before the connection
        // test, not after it: `addInstance` will not store such a URL (fetch
        // cannot even request one), and testing it first would answer with a
        // "cannot connect to the instance" message that names the wrong cause.
        if (hasUrlUserinfo(url)) {
          this._reply('saveInstanceResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // The declared version is validated *before* the connection test, and
        // refused with the reason rather than dropped: `ConfigManager` would
        // throw for it too, but that throw lands in the catch below, whose reply
        // says "the connection test failed" — a message about the wrong thing,
        // and one that would leave the user staring at a field the host ignored.
        const declared = parseDeclaredServerVersion(declaredServerVersion);
        if (declared.kind === 'invalid') {
          this._reply('saveInstanceResult', {
            success: false,
            error: declaredVersionRejection(),
          });
          return;
        }
        try {
          const client = new ForgejoClient(url, token, logger);
          const user = await client.getCurrentUser();

          const normalizedUrl = url.replace(/\/$/, '');
          const instance: ForgejoInstance = {
            id: instanceIdFor(normalizedUrl, user.login),
            url: normalizedUrl,
            token,
            name: instanceNameFor(normalizedUrl, user.login),
            username: user.login,
            syncApiUrlsToInstanceUrl,
            ...(declared.kind === 'declared' ? { declaredServerVersion: declared.version } : {}),
          };

          await this._config.addInstance(instance);
          // Drop stale per-URL caches before re-probing/re-detecting: the
          // server version may predate an upgrade (Actions gate) and the
          // linked-repository scan may hold a negative entry from before the
          // instance was configured.
          clearServerVersion(normalizedUrl);
          clearLinkedRepositoryCache();
          void probeServerVersion(normalizedUrl, token, logger, syncApiUrlsToInstanceUrl);
          this._sendInstances();
          this._detectAndSendLinkedRepository();
          this._reply('saveInstanceResult', { success: true });
          vscode.window.showInformationMessage(vscode.l10n.t('Connected to Forgejo as {0}', user.login));
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`saveInstance failed: ${err}`);
          // The reply gets the status-only rendering (as testConnection's does):
          // userFacingErrorMessage embeds the upstream response body for
          // 409/422, and that remote-authored content must not be reflected
          // into the webview (see connectionFailureMessage).
          this._reply('saveInstanceResult', { success: false, error: connectionFailureMessage(error) });
        }
        return;
      }
      case 'editInstance': {
        const { id, url, token, syncApiUrlsToInstanceUrl, declaredServerVersion } = message;
        if (typeof id !== 'string' || typeof url !== 'string' || typeof token !== 'string') {
          this._reply('saveInstanceResult', { success: false, error: vscode.l10n.t('Invalid input') });
          return;
        }
        // Same refusal as saveInstance, and for the same reason: an edit must
        // not store a version the gates would then ignore, and the user must see
        // why the form was not saved. What the field carries is applied below —
        // an empty value clears the declaration, an absent one leaves it alone.
        const declared = parseDeclaredServerVersion(declaredServerVersion);
        if (declared.kind === 'invalid') {
          this._reply('saveInstanceResult', {
            success: false,
            error: declaredVersionRejection(),
          });
          return;
        }
        // Same scheme gate as saveInstance, and for the same reason: an edit
        // must not introduce a URL the store would refuse to accept.
        if (!isHttpUrl(url)) {
          this._reply('saveInstanceResult', {
            success: false,
            error: vscode.l10n.t('Enter a valid http(s) URL for the Forgejo instance.'),
          });
          return;
        }
        // The Settings form is prefilled from `toPublicInstance`, which sends
        // the *redacted* URL of an instance whose stored URL carries a
        // credential (`https://***@host/`). Editing anything else on that
        // instance posts that masked value straight back. It parses as
        // http(s) and is same-origin, so nothing else here would stop it — the
        // connection test would simply fail and blame the instance, and the
        // stored credential would be replaced by a broken URL. `***` is not a
        // credential: it is refused, naming the real problem (the URL field
        // holds a mask, so the real URL has to be typed again) with the message
        // that already means exactly that. No l10n key of its own is added
        // because this change may not touch the bundles.
        if (hasRedactedUserinfo(url)) {
          this._reply('saveInstanceResult', {
            success: false,
            error: vscode.l10n.t('Changing the instance URL requires entering the access token again'),
          });
          return;
        }
        try {
          const existing = this._findInstance(id);
          if (!existing) {
            this._reply('saveInstanceResult', { success: false, error: vscode.l10n.t('Instance not found') });
            return;
          }
          // The webview never receives stored tokens; an empty token field
          // means "keep the current token", so validate with the stored one.
          // A URL change to a different origin must not be validated — let
          // alone persisted — with the stored token: that would hand the
          // token to a third-party host chosen by the webview.
          if (!token && !isSameOrigin(url, existing.url)) {
            this._reply('saveInstanceResult', {
              success: false,
              error: vscode.l10n.t('Changing the instance URL requires entering the access token again'),
            });
            return;
          }
          const effectiveToken = token || existing.token;
          const client = new ForgejoClient(url, effectiveToken, logger);
          const user = await client.getCurrentUser();

          const normalizedUrl = url.replace(/\/$/, '');
          await this._config.updateInstance(id, {
            url: normalizedUrl,
            token,
            // Same derivation as saveInstance/onboarding: a sub-path instance
            // keeps its name (and therefore its webview cache identity) when it
            // is edited without changing anything.
            name: instanceNameFor(normalizedUrl, user.login),
            username: user.login,
            syncApiUrlsToInstanceUrl,
            // Carried only when the form sent it: an emptied field is `''`,
            // which clears the declaration (see updateInstance), while a caller
            // that does not know the field at all leaves the stored one alone.
            ...(declaredServerVersion === undefined
              ? {}
              : { declaredServerVersion: declared.kind === 'declared' ? declared.version : '' }),
          });
          // Drop stale per-URL caches (old and new URL) before re-probing:
          // the cached server version never expires on its own, so an
          // upgraded server would otherwise stay behind the Actions gate.
          clearServerVersion(normalizedUrl);
          clearServerVersion(existing.url);
          clearLinkedRepositoryCache();
          void probeServerVersion(normalizedUrl, effectiveToken, logger, syncApiUrlsToInstanceUrl);
          this._sendInstances();
          this._detectAndSendLinkedRepository();
          this._reply('saveInstanceResult', { success: true });
          vscode.window.showInformationMessage(vscode.l10n.t('Updated Forgejo instance for {0}', user.login));
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editInstance failed: ${err}`);
          // Same status-only reply as saveInstance above (see
          // connectionFailureMessage): the upstream response body a 409/422
          // embeds is remote-authored and must not be reflected into the
          // webview.
          this._reply('saveInstanceResult', { success: false, error: connectionFailureMessage(error) });
        }
        return;
      }
      case 'removeInstance': {
        const { id } = message;
        if (typeof id !== 'string') {
          return;
        }
        const instance = this._findInstance(id);
        if (!instance) {
          return;
        }
        // The webview tracks no pending state for this command, so a declined
        // confirmation needs no reply: the instance list simply stays as is.
        if (!(await this._confirmDestructive(vscode.l10n.t('Remove instance "{0}"?', instance.name)))) {
          return;
        }
        // The checkouts deliberately stay on disk (they may hold uncommitted
        // work) and nothing points at them afterwards, so the notice below names
        // them: the lazy sweep only reclaims one whose source clone is gone, so
        // a checkout backed by an ordinary clone would otherwise be stranded
        // with no way to find it.
        const { removed: removedWorktrees, strandedCheckouts } = await this._config.removeInstance(id);
        if (removedWorktrees > 0) {
          // The checkouts are still on disk (they may hold uncommitted work);
          // say so, and where they are, instead of letting the user believe they
          // were deleted or lose track of them.
          void vscode.window.showInformationMessage(
            vscode.l10n.t(
              'Removed instance {0} along with its {1} worktree record(s). Their checkouts stay on disk at {2}; nothing tracks them any more, so delete them yourself once they hold no work you still need.',
              instance.name,
              removedWorktrees,
              strandedCheckouts.join(', '),
            ),
          );
        }
        this._sendInstances();
        // Removing an instance forgets its worktree records (their checkouts
        // stay on disk). The Settings list renders the last `worktreesList`
        // reply, so without this it keeps showing rows whose records are gone:
        // deleting one would reach the removal path with nothing behind it.
        this._sendWorktrees();
        this._detectAndSendLinkedRepository();
        return;
      }
      case 'exportInstances': {
        const ids = Array.isArray((message as { ids?: unknown[] }).ids)
          ? ((message as { ids?: string[] }).ids as string[])
          : undefined;
        await this._exportInstances(ids);
        return;
      }
      case 'copyInstancesToClipboard': {
        const ids = Array.isArray((message as { ids?: unknown[] }).ids)
          ? ((message as { ids?: string[] }).ids as string[])
          : undefined;
        await this._copyInstancesToClipboard(ids);
        return;
      }
      case 'previewImportInstances': {
        await this._previewImportInstances();
        return;
      }
      case 'importInstances': {
        const rawIds = (message as { ids?: unknown }).ids;
        const settings = (message as { settings?: ExportSettings }).settings;
        const aiConflicts = sanitizeAiConflictChoices((message as { aiConflicts?: unknown }).aiConflicts);
        if (Array.isArray(rawIds)) {
          // Preview confirmation: rehydrate the selected entries from the
          // host-side stash. Instance data sent by the webview (tokens in
          // particular) is untrusted and ignored entirely.
          const pending = this._pendingImportInstances;
          this._pendingImportInstances = undefined;
          if (!pending) {
            this._pendingImportAi = undefined;
            this._reply('instancesImported', {
              success: false,
              error: vscode.l10n.t('The import preview is no longer available; please pick the file again'),
            });
            return;
          }
          const wanted = new Set(rawIds.filter((id): id is string => typeof id === 'string'));
          const selected = pending.filter((instance) => wanted.has(instance.id));
          if (selected.length === 0) {
            this._pendingImportAi = undefined;
            this._reply('instancesImported', {
              success: false,
              error: vscode.l10n.t('No valid instances found in the import data'),
            });
            return;
          }
          await this._importInstances(selected, settings, aiConflicts);
          return;
        }
        // No ids: the picker form, which has no preview to confirm the AI
        // configuration in. The stash (if any) is not applied and is dropped.
        this._pendingImportAi = undefined;
        await this._importInstances(undefined, settings);
        return;
      }
      case 'cancelImportInstances': {
        this._pendingImportInstances = undefined;
        this._pendingImportAi = undefined;
        return;
      }
      case 'setLocale': {
        const newLocale = message.locale;
        if (typeof newLocale === 'string' && (newLocale === 'en' || newLocale === 'zh')) {
          await vscode.workspace.getConfiguration('forgejoToolkit').update('locale', newLocale, true);
          this._reply('setLocale', { locale: newLocale });
          this._updateViewTitle(newLocale);
        }
        return;
      }
      case 'setDebug': {
        const debug = message.debug;
        if (typeof debug === 'boolean') {
          await vscode.workspace.getConfiguration('forgejoToolkit').update('debug', debug, true);
        }
        return;
      }
      // The AI pre-review started from the pull request detail page. The
      // coordinates are validated here, at the dispatch, and then handed to the
      // very run the `editor/title` button reaches: one implementation, two
      // entry points. Nothing else about the run is read from the message — the
      // webview says which pull request, and the host decides everything else
      // (model, scope, prompt, confirmation, drafts).
      //
      // The feature switch is deliberately **not** checked here. The run checks
      // it as its first act and refuses with a pointer to the setting, and the
      // dashboard hides the button while it is off, so a second gate in the
      // dispatch would be an affordance rule pretending to be a guarantee.
      case 'aiPreReviewPullRequest': {
        const target = parseWebviewPullRequestTarget(message);
        if (!target) {
          logger.error('aiPreReviewPullRequest refused a message that does not name a valid pull request');
          void vscode.window.showErrorMessage(
            vscode.l10n.t(
              'The AI pre-review was not started: the request did not name a valid pull request. Nothing was sent and nothing was created.',
            ),
          );
          return;
        }
        if (!this._aiPreReviewRunner) {
          logger.error('aiPreReviewPullRequest arrived before the AI pre-review was registered');
          return;
        }
        this._aiPreReviewRunner(target);
        return;
      }
      // The "generate a description" action, from the create form or from an
      // existing pull request's edit dialog. The coordinates are the comparison the
      // form holds and nothing else: the model, the scope, the consent question and
      // the prompt all belong to `src/prDescription.ts`. What comes back is text,
      // which is the whole point — a message that could name a title, a body or a
      // merge strategy would be an extension that opens pull requests, and this one
      // does not. `index` is present only on the existing-pull-request surface,
      // where it is what the `commits-and-diff` scope reads its material from; a
      // malformed one refuses the whole message rather than degrading it.
      //
      // The feature switch is deliberately **not** checked here, for the same
      // reason `aiPreReviewPullRequest` does not check its own: the run checks it
      // first and refuses with a pointer to the setting, and the form hides the
      // button while it is off.
      case 'generatePrDescription': {
        const { instanceId, owner, repo, base, head, index, title, _requestId } = message;
        if (typeof _requestId !== 'string') {
          logger.error('generatePrDescription carried no request id, so there is nothing to answer');
          return;
        }
        if (!this._prDescriptionRunner) {
          logger.error('generatePrDescription arrived before the PR-description run was registered');
          return;
        }
        const target = parsePrDescriptionRequest({ instanceId, owner, repo, base, head, index, title });
        if (!target) {
          logger.error('generatePrDescription refused a message that does not name a usable comparison');
          this._reply('prDescriptionGenerated', {
            error: vscode.l10n.t(
              'The description was not drafted: the request did not name a usable comparison. Nothing was sent.',
            ),
            _requestId,
          });
          return;
        }
        // **Awaited, not fired and forgotten.** The dispatch wrapper above
        // (`_dispatchMessage`) answers an unanswered `_requestId` with
        // `requestError` as soon as this handler returns, and this handler used to
        // return the moment the run was started. The run's own reply then arrived
        // after the fallback, found no pending entry in the webview and was
        // discarded, so the description never reached the form and the user saw
        // only the generic sentence. Measured five times on 2026-10-05: every
        // press logged `requestError` immediately followed by
        // `prDescriptionGenerated` for the same id. Awaiting makes the run's reply
        // the only answer for the id — the fallback still fires if the run throws,
        // because `_reply` is what marks the id answered.
        await this._runPrDescription(target, _requestId);
        return;
      }
      // The Settings page's AI pre-review model chooser. Both cases are pure
      // configuration: they work with `forgejoToolkit.aiPreReview` off, and
      // neither one sends anything to a model provider — `listAiPreReviewChatModelChoices`
      // only asks the editor which models exist.
      case 'getAiPreReviewChatModels': {
        const listing = await listAiPreReviewChatModelChoices();
        this._reply('aiPreReviewChatModels', { ...listing, _requestId: message._requestId });
        return;
      }
      case 'setAiPreReviewChatModel': {
        const { value } = message;
        // The webview is untrusted input, and this writes a user setting: only
        // the empty value (the setting's own "ask me" default) or one of the two
        // accepted selector forms may be stored, which is the same gate a
        // hand-typed value passes on the next run.
        if (typeof value !== 'string' || !isStorableAiPreReviewModelSettingValue(value)) {
          logger.error('setAiPreReviewChatModel rejected a value that is not an accepted model selector');
          this._reply('aiPreReviewChatModelSaved', {
            value: typeof value === 'string' ? value : '',
            error: vscode.l10n.t('The model choice was not stored: it is not a "vendor/family" or "vendor/id" form.'),
            _requestId: message._requestId,
          });
          return;
        }
        try {
          await writeAiPreReviewModelSetting(value);
          logger.info(`AI pre-review: the settings page wrote "${AI_PRE_REVIEW_MODEL_SETTING}" = "${value}"`);
          this._reply('aiPreReviewChatModelSaved', { value, _requestId: message._requestId });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`setAiPreReviewChatModel could not write the model choice: ${err}`);
          this._reply('aiPreReviewChatModelSaved', { value, error: err, _requestId: message._requestId });
        }
        return;
      }
      // The settings page's AI endpoint (provider) surface. Reading the snapshot
      // sends nothing anywhere: it lists the declared models, reads which secrets
      // are stored, and asks `selectedModelFor` which transport *would* serve the
      // one AI feature. `testAiProvider` is the only case here that sends a
      // request, and it is reached from one explicit click (§7.2).
      case 'getAiProviderSettings': {
        const snapshot = await readAiProviderSettings({ secrets: this._context.secrets });
        this._reply('aiProviderSettings', { snapshot, _requestId: message._requestId });
        return;
      }
      case 'saveAiProvider': {
        const rawId = (message.provider as { id?: unknown }).id;
        const result = await saveAiProvider({ secrets: this._context.secrets }, message.provider);
        this._reply('aiProviderSaved', {
          id: typeof rawId === 'string' ? rawId.trim() : '',
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        // The page renders stored-or-not for every secret and the reader's own
        // rejections, so the write is followed by the host's reading of the state
        // it just produced rather than by expecting the page to re-derive it.
        await this._pushAiProviderSettings();
        return;
      }
      case 'removeAiProvider': {
        const { id } = message;
        // Removal is destructive — it deletes a configured endpoint and forgets
        // its secrets — so the confirmation is the host's own, like every other
        // destructive webview command (`_confirmDestructive`). A declined prompt
        // is answered rather than dropped: the request carries a `_requestId`, so
        // silence would leave the page waiting and then time out.
        const name = this._aiProviderName(id);
        if (
          !(await this._confirmDestructive(vscode.l10n.t('Remove the AI endpoint "{0}" and its stored secrets?', name)))
        ) {
          this._reply('aiProviderRemoved', { id, cancelled: true, _requestId: message._requestId });
          return;
        }
        const result = await removeAiProvider({ secrets: this._context.secrets }, id);
        this._reply('aiProviderRemoved', {
          id,
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        await this._pushAiProviderSettings();
        return;
      }
      case 'setAiProviderSecret': {
        const result = await writeAiProviderSecret(
          { secrets: this._context.secrets },
          message.id,
          message.headerName,
          message.value,
        );
        this._reply('aiProviderSecretSaved', {
          id: message.id,
          ...(message.headerName === undefined ? {} : { headerName: message.headerName }),
          set: result.ok ? result.set : false,
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        await this._pushAiProviderSettings();
        return;
      }
      case 'testAiProvider': {
        const report = await testAiProvider({ secrets: this._context.secrets }, message.id);
        if (report === undefined) {
          this._reply('aiProviderTestReport', {
            report: {
              providerId: message.id,
              providerName: message.id,
              address: '',
              ok: false,
              ran: false,
              reason: vscode.l10n.t('No AI endpoint with the id "{0}" is configured.', message.id),
              shadowed: [],
            },
            _requestId: message._requestId,
          });
          return;
        }
        this._reply('aiProviderTestReport', { report, _requestId: message._requestId });
        return;
      }
      // The draft probe (`docs/design/settings-page.md` §4): the endpoint editor's
      // own fields, probed **without** saving anything. The typed credential is
      // held for this one request and is never written to settings or to secret
      // storage, and the probe itself only ever asks for the model list — the
      // minimal completion stays behind the explicit test-connection click. It is
      // the first path in this extension that sends without a click, which is why
      // the webview's own idle/one-shot rules and the local refusals above it are
      // the whole reason it is acceptable (the record's §8.1 states the cost).
      case 'testAiProviderDraft': {
        const report = await aiProviderDraftTestReport(message.draft, { secrets: this._context.secrets });
        this._reply('aiProviderTestReport', { report, _requestId: message._requestId });
        return;
      }
      // The settings page's own surface: every setting its sections render with a
      // control. Reading sends nothing anywhere and writes nothing; a write
      // is validated (the webview is untrusted input) and answered with the host's
      // own reading of the state it produced, so the control on screen always
      // shows what is actually stored.
      case 'getSettingsSurface': {
        this._reply('settingsSurface', { snapshot: this._readSettingsSurface(), _requestId: message._requestId });
        return;
      }
      case 'setSettingsSurfaceValue': {
        const result = await writeSettingsSurfaceValue(message.key, message.value);
        this._reply('settingsSurface', {
          snapshot: this._readSettingsSurface(),
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        return;
      }
      // The settings page's header control and every source note's own action land
      // here, and all of them run the **command** rather than reaching for
      // `executeCommand` here: one implementation, and the command is also what the
      // palette offers. It carries the `@ext:` filter, which is the whole point —
      // an unfiltered settings editor is the place the user could not find this
      // extension's settings in.
      case 'openNativeSettings': {
        void vscode.commands.executeCommand('forgejoToolkit.openNativeSettings');
        return;
      }
      case 'setAiModelPolicy': {
        const result = await writeAiModelPolicy({ secrets: this._context.secrets }, message);
        // One reading serves both the reply and the push: the reply reports what is
        // stored now, which is the same fact the page renders from the snapshot.
        const snapshot = await readAiProviderSettings({ secrets: this._context.secrets });
        this._reply('aiModelPolicySaved', {
          transport: snapshot.transport,
          requestTimeoutMs: snapshot.requestTimeoutMs,
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        this._reply('aiProviderSettings', { snapshot });
        return;
      }
      case 'setAiModelBinding': {
        const result = await writeAiModelBinding({ secrets: this._context.secrets }, message);
        this._reply('aiModelBindingSaved', {
          feature: message.feature,
          providerId: message.providerId,
          modelId: message.modelId,
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        await this._pushAiProviderSettings();
        return;
      }
      // The default destination the per-feature bindings override (§8.4): its own
      // message rather than a binding for a pseudo-feature, because it is its own
      // pair of settings and the page has to be able to say which of the two it
      // just wrote.
      case 'setAiDefaultModel': {
        const result = await writeAiDefaultModel({ secrets: this._context.secrets }, message);
        this._reply('aiDefaultModelSaved', {
          providerId: message.providerId,
          modelId: message.modelId,
          ...(result.ok ? {} : { error: result.error }),
          _requestId: message._requestId,
        });
        await this._pushAiProviderSettings();
        return;
      }
      case 'openExternal': {
        const url = message.url;
        if (typeof url !== 'string') {
          return;
        }
        const uri = vscode.Uri.parse(url);
        // The webview is untrusted input: only open web URLs. Local paths
        // (e.g. worktree directories) go through the validated
        // openWorktreePath message instead.
        if (uri.scheme !== 'http' && uri.scheme !== 'https') {
          logger.error(`Blocked openExternal with disallowed scheme "${uri.scheme}": ${redactUrlUserinfo(url)}`);
          return;
        }
        try {
          await vscode.env.openExternal(uri);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openExternal failed for ${redactUrlUserinfo(url)}: ${err}`);
        }
        return;
      }
      case 'openWorktreePath': {
        const worktreePath = message.path;
        if (typeof worktreePath !== 'string') {
          return;
        }
        // Only paths of recorded worktrees may be opened; the webview
        // cannot probe arbitrary local paths this way.
        const known = this._worktreeManager.getWorktrees().some((w) => w.worktreePath === worktreePath);
        if (!known) {
          logger.error(`Blocked openWorktreePath for unknown worktree path: ${worktreePath}`);
          return;
        }
        try {
          await vscode.env.openExternal(vscode.Uri.file(worktreePath));
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openWorktreePath failed for ${worktreePath}: ${err}`);
        }
        return;
      }
      case 'getRepositories': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const repos = await client.getUserRepositories();
          logger.info(`getRepositories returned ${repos.items.length} repos for ${instance.name}`);
          this._reply('repositories', {
            instanceId: instance.id,
            repositories: repos.items,
            ...(repos.totalCount !== undefined ? { totalCount: repos.totalCount } : {}),
            ...echoedListRequestId(message),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepositories failed for ${instance.name}: ${err}`);
          this._reply('repositories', { instanceId: message.instanceId, error: err, ...echoedListRequestId(message) });
        }
        return;
      }
      case 'getMyIssues': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        // Echo the requested state so the webview can route the reply to the
        // right state-scoped slot even when several states load concurrently.
        const state = typeof message.state === 'string' ? message.state : 'open';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issues = await client.getUserIssues(state);
          this._reply('myIssues', { instanceId: instance.id, state, issues, ...echoedListRequestId(message) });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getMyIssues failed for ${instance.name}: ${err}`);
          this._reply('myIssues', {
            instanceId: message.instanceId,
            state,
            error: err,
            ...echoedListRequestId(message),
          });
        }
        return;
      }
      case 'getMyPullRequests': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const state = typeof message.state === 'string' ? message.state : 'open';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const pulls = await client.getUserPullRequests(state);
          this._reply('myPullRequests', {
            instanceId: instance.id,
            state,
            pullRequests: pulls,
            ...echoedListRequestId(message),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getMyPullRequests failed for ${instance.name}: ${err}`);
          this._reply('myPullRequests', {
            instanceId: message.instanceId,
            state,
            error: err,
            ...echoedListRequestId(message),
          });
        }
        return;
      }
      case 'globalSearch': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { scope: rawScope, query, state: searchState, limit } = message;
        if (
          typeof rawScope !== 'string' ||
          typeof query !== 'string' ||
          typeof searchState !== 'string' ||
          !['all', 'repositories', 'issues', 'pullRequests'].includes(rawScope)
        ) {
          // The search view only clears its loading gate on a
          // `globalSearchResult` reply and this message carries no
          // `_requestId`, so the dispatch fallback cannot answer it.
          this._replyResultShapedError(
            message,
            'globalSearchResult',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        const scope = rawScope as 'all' | 'repositories' | 'issues' | 'pullRequests';
        const state = ['open', 'closed', 'all'].includes(searchState) ? searchState : 'all';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const [repositories, issues, pullRequests] = await Promise.all([
            scope === 'all' || scope === 'repositories'
              ? client.searchRepositories(query, limit ?? 20)
              : Promise.resolve(undefined),
            scope === 'all' || scope === 'issues'
              ? client.searchIssues(query, state, limit ?? 20)
              : Promise.resolve(undefined),
            scope === 'all' || scope === 'pullRequests'
              ? client.searchPullRequests(query, state, limit ?? 20)
              : Promise.resolve(undefined),
          ]);
          logger.info(
            `globalSearch [${scope}] "${query}" (${state}) for ${instance.name}: repos=${repositories?.length ?? 0}, issues=${issues?.length ?? 0}, pulls=${pullRequests?.length ?? 0}`,
          );
          this._reply('globalSearchResult', {
            instanceId: instance.id,
            scope,
            query,
            state,
            repositories,
            issues,
            pullRequests,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`globalSearch failed for ${instance.name}: ${err}`);
          this._reply('globalSearchResult', {
            instanceId: message.instanceId,
            scope,
            query,
            state,
            error: err,
          });
        }
        return;
      }
      case 'getNotifications': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { statusTypes, subjectType, limit, before } = message;
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const cursor = typeof before === 'string' && before ? before : undefined;
          const notifications = await client.getNotifications(
            Array.isArray(statusTypes) ? statusTypes : undefined,
            Array.isArray(subjectType)
              ? (subjectType.filter((t): t is 'issue' | 'pull' | 'repository' =>
                  ['issue', 'pull', 'repository'].includes(t as string),
                ) as ('issue' | 'pull' | 'repository')[])
              : undefined,
            typeof limit === 'number' ? limit : 50,
            cursor,
          );
          logger.info(
            `getNotifications returned ${notifications.items.length} items for ${instance.name}${cursor ? ` before ${cursor}` : ''}`,
          );
          this._reply('notifications', {
            instanceId: instance.id,
            notifications: notifications.items,
            ...(notifications.totalCount !== undefined ? { totalCount: notifications.totalCount } : {}),
            ...(cursor ? { before: cursor } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getNotifications failed for ${instance.name}: ${err}`);
          this._reply('notifications', { instanceId: message.instanceId, error: err });
        }
        return;
      }
      case 'markNotificationRead': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { id } = message;
        if (typeof id !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.markNotificationRead(id);
          this._reply('notificationMarkedRead', { instanceId: instance.id, id });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`markNotificationRead failed for ${instance.name}/${id}: ${err}`);
          this._reply('notificationMarkedRead', { instanceId: message.instanceId, id, error: err });
        }
        return;
      }
      case 'markAllNotificationsRead': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.markAllNotificationsRead();
          this._reply('allNotificationsMarkedRead', { instanceId: instance.id });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`markAllNotificationsRead failed for ${instance.name}: ${err}`);
          this._reply('allNotificationsMarkedRead', { instanceId: message.instanceId, error: err });
        }
        return;
      }
      case 'getRepoDetail': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const detail = await client.getRepoDetail(owner, repo);
          // Three README shapes reach the dashboard, and the order below is what
          // keeps them apart. `readmeNotice` is the localized sentence for a
          // README that is not a regular file (a symlink or a submodule): it
          // replaces the client's English sentence in `readme`, which is written
          // for the headless MCP tools and must not be what a Chinese UI shows.
          // Then `readme` itself — the file's text, or that English sentence when
          // a hand-built payload carries no `readmeNotice`. Last
          // `detail.readmeSize`, set only for a payload the contents API withheld
          // (and only for a non-empty one), so an absent README and a genuinely
          // empty one need no second `/contents/README.md` probe either way.
          const readme =
            readmeNoticeText(detail.readmeNotice) ??
            detail.readme ??
            (detail.readmeSize !== undefined ? missingPayloadNotice(detail.readmeSize) : undefined);
          const detailWithResolvedAvatars = await this._resolveCommitAvatars({ ...detail, readme }, instance);
          this._reply('repoDetail', {
            instanceId: instance.id,
            owner,
            repo,
            detail: detailWithResolvedAvatars,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoDetail failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoDetail', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'getRepoBranchCommits': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, branch } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof branch !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const commits = await client.getRepoBranchCommits(owner, repo, branch);
          const commitsWithResolvedAvatars = await this._resolveCommitAvatars(
            {
              repository: {},
              branches: [],
              recentCommits: commits,
            },
            instance,
          );
          this._reply('repoBranchCommits', {
            instanceId: instance.id,
            owner,
            repo,
            branch,
            commits: commitsWithResolvedAvatars.recentCommits,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoBranchCommits failed for ${instance.name}/${owner}/${repo}/${branch}: ${err}`);
          this._reply('repoBranchCommits', {
            instanceId: message.instanceId,
            owner,
            repo,
            branch,
            error: err,
          });
        }
        return;
      }
      case 'getIssueDetail': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const detail = await client.getIssueDetail(owner, repo, index);
          this._reply('issueDetail', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            detail,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueDetail failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDetail', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'createIssue': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || !data || typeof data.title !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const item = await client.createIssue(owner, repo, data);
          this._reply('issueCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index: (item as { number?: number }).number ?? 0,
            item,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createIssue failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('issueCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index: 0,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'editIssue': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number' || !data) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const {
            labels,
            state_toggle: stateToggle,
            due_date_update: dueDateUpdate,
            ...issueData
          } = data as {
            title?: string;
            body?: string;
            state?: string;
            labels?: number[];
            assignees?: string[];
            milestone?: number;
            due_date?: string;
            unset_due_date?: boolean;
            state_toggle?: boolean;
            due_date_update?: boolean;
          };
          const item = await client.editIssue(owner, repo, index, issueData);
          if (Array.isArray(labels)) {
            await client.replaceIssueLabels(owner, repo, index, labels);
          }
          this._reply('issueUpdated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            item,
            ...(stateToggle ? { stateToggle: true } : {}),
            ...(dueDateUpdate ? { dueDateUpdate: true } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editIssue failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueUpdated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            ...((data as { state_toggle?: boolean }).state_toggle ? { stateToggle: true } : {}),
            ...((data as { due_date_update?: boolean }).due_date_update ? { dueDateUpdate: true } : {}),
          });
        }
        return;
      }
      case 'deleteIssue': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // Explicit cancel reply (like the import preview): the webview's
        // loading state for this command would never clear otherwise.
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete issue #{0} in {1}? This cannot be undone.',
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueDeleted', { instanceId: instance.id, owner, repo, index, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssue(owner, repo, index);
          this._reply('issueDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssue failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDeleted', { instanceId: message.instanceId, owner, repo, index, error: err });
        }
        return;
      }
      case 'checkIssueSubscription': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const info = await client.checkIssueSubscription(owner, repo, index);
          this._reply('issueSubscriptionChecked', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            subscribed: info.subscribed,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`checkIssueSubscription failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueSubscriptionChecked', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'changeIssueSubscription': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, user, subscribe } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          // `user` becomes the last path segment of a subscription route; a value
          // like `../..` would retarget a prompt-free unsubscribe at another API
          // path, so it is held to the same rule as a repository name.
          !isSafeRepoNameSegment(user)
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (subscribe) {
            await client.addIssueSubscription(owner, repo, index, user);
          } else {
            await client.deleteIssueSubscription(owner, repo, index, user);
          }
          this._reply('issueSubscriptionChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            subscribed: subscribe,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`changeIssueSubscription failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueSubscriptionChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'startIssueStopwatch':
      case 'stopIssueStopwatch':
      case 'deleteIssueStopwatch': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // Confirmed before the client is built: a declined confirmation must not
        // even construct a request. Start/stop are not destructive, so only the
        // delete action prompts.
        if (message.command === 'deleteIssueStopwatch') {
          if (
            !(await this._confirmDestructive(
              vscode.l10n.t(
                'Discard the running timer for issue #{0} in {1}?',
                index,
                confirmInstanceScope(instance, owner, repo),
              ),
            ))
          ) {
            // Answer with `cancelled` so the webview clears its pending state
            // without treating the decline as a failure.
            this._reply('issueStopwatchChanged', {
              instanceId: instance.id,
              owner,
              repo,
              index,
              action: 'delete',
              cancelled: true,
            });
            return;
          }
        }
        // Derived from the request before the try, so the catch can echo the
        // action the failure belongs to: the shared contract documents
        // `issueStopwatchChanged.action` as the requested action, and a failed
        // stop/delete hardcoded to 'start' would mislead a consumer.
        const action: 'start' | 'stop' | 'delete' =
          message.command === 'startIssueStopwatch'
            ? 'start'
            : message.command === 'stopIssueStopwatch'
              ? 'stop'
              : 'delete';
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (message.command === 'startIssueStopwatch') {
            await client.startIssueStopwatch(owner, repo, index);
          } else if (message.command === 'stopIssueStopwatch') {
            await client.stopIssueStopwatch(owner, repo, index);
          } else {
            await client.deleteIssueStopwatch(owner, repo, index);
          }
          this._reply('issueStopwatchChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            action,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`${message.command} failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueStopwatchChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            action,
            error: err,
          });
        }
        return;
      }
      case 'getUserStopwatches': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const stopwatches = await client.getUserStopWatches();
          this._reply('userStopwatches', {
            instanceId: instance.id,
            stopwatches,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getUserStopWatches failed for ${instance.name}: ${err}`);
          this._reply('userStopwatches', {
            instanceId: message.instanceId,
            error: err,
          });
        }
        return;
      }
      case 'getIssueTrackedTimes': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const times = await client.listIssueTrackedTimes(owner, repo, index);
          this._reply('issueTrackedTimes', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            times,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueTrackedTimes failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTrackedTimes', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'addIssueTime': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, time } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof time !== 'number'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const trackedTime = await client.addIssueTime(owner, repo, index, time);
          this._reply('issueTimeAdded', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            time: trackedTime,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`addIssueTime failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTimeAdded', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'resetIssueTime': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // The same host-enforced confirmation as the single-entry
        // deleteIssueTime below: DELETE .../times drops every tracked-time
        // entry of the issue at once, which is strictly more destructive than
        // the confirmed single-entry delete. The webview must not add its own
        // prompt (that would double-prompt).
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete all tracked time entries for issue #{0} in {1}? This cannot be undone.',
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueTimeReset', { instanceId: instance.id, owner, repo, index, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.resetIssueTime(owner, repo, index);
          this._reply('issueTimeReset', {
            instanceId: instance.id,
            owner,
            repo,
            index,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`resetIssueTime failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTimeReset', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'deleteIssueTime': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, id } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof id !== 'number'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete this tracked time entry in {0}?', confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('issueTimeDeleted', { instanceId: instance.id, owner, repo, index, id, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueTime(owner, repo, index, id);
          this._reply('issueTimeDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            id,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssueTime failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueTimeDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            id,
            error: err,
          });
        }
        return;
      }
      case 'getIssueDependencies': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const dependencies = await client.listIssueDependencies(owner, repo, index);
          this._reply('issueDependencies', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            dependencies,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueDependencies failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDependencies', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'createIssueDependency':
      case 'removeIssueDependency': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, dependencyIndex } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof dependencyIndex !== 'number'
        ) {
          return;
        }
        // Only removal is destructive; creation needs no confirmation.
        if (
          message.command === 'removeIssueDependency' &&
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Remove the dependency on #{0} for issue #{1} in {2}?',
              dependencyIndex,
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueDependencyChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            dependencyIndex,
            action: 'remove',
            cancelled: true,
          });
          return;
        }
        // Derived from the request before the try, so the catch can echo the
        // action that failed ('add' for create, 'remove' for remove) instead of
        // the hardcoded 'add' the shared contract does not allow.
        const action = message.command === 'createIssueDependency' ? ('add' as const) : ('remove' as const);
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (message.command === 'createIssueDependency') {
            await client.createIssueDependency(owner, repo, index, dependencyIndex);
          } else {
            await client.removeIssueDependency(owner, repo, index, dependencyIndex);
          }
          this._reply('issueDependencyChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            dependencyIndex,
            action,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`${message.command} failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueDependencyChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            dependencyIndex,
            action,
            error: err,
          });
        }
        return;
      }
      case 'getIssueReactions': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const reactions = await client.getIssueReactions(owner, repo, index);
          this._reply('issueReactions', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            reactions,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssueReactions failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueReactions', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'changeIssueReaction': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, content, add } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof content !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (add) {
            await client.addIssueReaction(owner, repo, index, content);
          } else {
            await client.removeIssueReaction(owner, repo, index, content);
          }
          this._reply('issueReactionChanged', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            content,
            action: add ? 'add' : 'remove',
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`changeIssueReaction failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueReactionChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            content,
            // The action the request carried, not a hardcoded 'add': a failed
            // removal must not report itself as an addition.
            action: add ? 'add' : 'remove',
            error: err,
          });
        }
        return;
      }
      case 'getCommentReactions': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof commentId !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const reactions = await client.getCommentReactions(owner, repo, commentId);
          this._reply('commentReactions', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            reactions,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `getCommentReactions failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`,
          );
          this._reply('commentReactions', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            error: err,
          });
        }
        return;
      }
      case 'changeCommentReaction': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId, content, add } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof commentId !== 'number' ||
          typeof content !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          if (add) {
            await client.addCommentReaction(owner, repo, commentId, content);
          } else {
            await client.removeCommentReaction(owner, repo, commentId, content);
          }
          this._reply('commentReactionChanged', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            content,
            action: add ? 'add' : 'remove',
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `changeCommentReaction failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`,
          );
          this._reply('commentReactionChanged', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            content,
            // The action the request carried, not a hardcoded 'add': a failed
            // removal must not report itself as an addition.
            action: add ? 'add' : 'remove',
            error: err,
          });
        }
        return;
      }
      case 'createIssueComment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, body } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof body !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const comment = await client.createIssueComment(owner, repo, index, body);
          this._reply('issueCommentCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            comment,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createIssueComment failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueCommentCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'createIssueCommentAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, commentId, name, data } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof commentId !== 'number' ||
          typeof name !== 'string' ||
          !Array.isArray(data)
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const attachment = await client.createIssueCommentAttachment(
            owner,
            repo,
            commentId,
            new Uint8Array(data),
            name,
          );
          this._reply('issueCommentAttachmentCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            commentId,
            id: attachment.id,
            uuid: attachment.uuid,
            name: attachment.name,
            size: attachment.size,
            browser_download_url: attachment.browser_download_url,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `createIssueCommentAttachment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`,
          );
          this._reply('issueCommentAttachmentCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            commentId,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'editIssueComment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId, body } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof commentId !== 'number' ||
          typeof body !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const comment = await client.editIssueComment(owner, repo, commentId, body);
          this._reply('issueCommentEdited', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            comment,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editIssueComment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`);
          this._reply('issueCommentEdited', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            error: err,
          });
        }
        return;
      }
      case 'deleteIssueComment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof commentId !== 'number') {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete comment #{0} in {1}?', commentId, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('issueCommentDeleted', { instanceId: instance.id, owner, repo, commentId, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueComment(owner, repo, commentId);
          this._reply('issueCommentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssueComment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}: ${err}`);
          this._reply('issueCommentDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            error: err,
          });
        }
        return;
      }
      case 'deleteIssueCommentAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, commentId, attachmentId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof commentId !== 'number' ||
          typeof attachmentId !== 'number'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete attachment #{0} of comment #{1} in {2}?',
              attachmentId,
              commentId,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueCommentAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            attachmentId,
            cancelled: true,
            _requestId: message._requestId,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueCommentAttachment(owner, repo, commentId, attachmentId);
          this._reply('issueCommentAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            commentId,
            attachmentId,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `deleteIssueCommentAttachment failed for ${instance.name}/${owner}/${repo}/comments/${commentId}/assets/${attachmentId}: ${err}`,
          );
          this._reply('issueCommentAttachmentDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            commentId,
            attachmentId,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'mergePullRequest': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, strategy } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          !['merge', 'rebase', 'squash'].includes(strategy)
        ) {
          return;
        }
        // Double-click/double-submit guard: a rapid second merge for the same
        // PR reuses the in-flight run instead of issuing the merge API call
        // twice (the second call would fail or merge twice). The reused run
        // replies only once, but the reply is keyed by PR coordinates, which
        // is exactly the webview's loading key, so the late trigger's spinner
        // clears with it.
        await this._prMutationInFlight.run(`merge:${instance.id}:${owner}/${repo}#${index}`, async () => {
          // The confirmation lives inside the guard: a second click landing
          // while the dialog is open reuses this run, so the user is never
          // prompted — nor merged — twice.
          if (
            !(await this._confirmDestructive(
              vscode.l10n.t(
                'Merge pull request #{0} in {1} using "{2}"? This cannot be undone.',
                index,
                confirmInstanceScope(instance, owner, repo),
                mergeStrategyLabel(strategy as 'merge' | 'rebase' | 'squash'),
              ),
            ))
          ) {
            this._reply('pullRequestMerged', { instanceId: instance.id, owner, repo, index, cancelled: true });
            return;
          }
          try {
            const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
            await client.mergePullRequest(owner, repo, index, strategy);
            this._reply('pullRequestMerged', {
              instanceId: instance.id,
              owner,
              repo,
              index,
            });
            this.onPullRequestsChanged?.();
          } catch (error) {
            const err = userFacingErrorMessage(error);
            logger.error(`mergePullRequest failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
            this._reply('pullRequestMerged', {
              instanceId: message.instanceId,
              owner,
              repo,
              index,
              error: err,
            });
          }
        });
        return;
      }
      case 'revertMergeCommit': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        // Same double-click guard as mergePullRequest (see above): the `revert:`
        // prefix keeps it a separate in-flight entry so a revert racing a merge
        // of the same PR is not silently dropped.
        await this._prMutationInFlight.run(`revert:${instance.id}:${owner}/${repo}#${index}`, async () => {
          if (
            !(await this._confirmDestructive(
              vscode.l10n.t(
                'Revert the merge commit of pull request #{0} in {1}? This will create a new commit on the base branch.',
                index,
                confirmInstanceScope(instance, owner, repo),
              ),
            ))
          ) {
            this._reply('revertMergeCommitResult', { instanceId: instance.id, owner, repo, index, cancelled: true });
            return;
          }
          try {
            const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
            const pr = await client.getPullRequestDetail(owner, repo, index);
            if (!pr.merged) {
              throw new Error(vscode.l10n.t('Pull request {0}/{1}#{2} is not merged', owner, repo, index));
            }
            if (!pr.merge_commit_sha) {
              throw new Error(
                vscode.l10n.t('Pull request {0}/{1}#{2} does not have a recorded merge commit', owner, repo, index),
              );
            }
            const localRepo = await findLocalRepo(instance.url, owner, repo);
            if (!localRepo) {
              throw new Error(vscode.l10n.t('No local repository found for {0}/{1}', owner, repo));
            }
            await revertMergeCommit(localRepo, pr.merge_commit_sha, pr.base?.ref, instance.token, instance.url, {
              owner,
              repo,
            });
            this._reply('revertMergeCommitResult', {
              instanceId: instance.id,
              owner,
              repo,
              index,
              success: true,
            });
          } catch (error) {
            const err = userFacingErrorMessage(error);
            logger.error(`revertMergeCommit failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
            // `revertMergeCommit` reports the state it left behind in its own
            // message (the local revert is undone on failure). This only covers
            // a failure that happened outside its cleanup — e.g. the API call or
            // the local-repository lookup failing after a manual `git revert`
            // left the repository mid-revert — so the user is never told a
            // success for a revert that never happened, nor left wondering why
            // the repository is in a revert state.
            const localRepo = await findLocalRepo(instance.url, owner, repo).catch(() => undefined);
            const midRevert =
              localRepo !== undefined &&
              (await isRevertInProgress(localRepo).catch(() => false)) &&
              !err.includes('git revert --abort');
            this._reply('revertMergeCommitResult', {
              instanceId: message.instanceId,
              owner,
              repo,
              index,
              error: midRevert
                ? vscode.l10n.t(
                    '{0}. The repository is still in the middle of the revert, so nothing was reverted or pushed; run "git revert --abort" in the local repository to undo it.',
                    err,
                  )
                : err,
            });
          }
        });
        return;
      }
      case 'createIssueAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, name, data } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof name !== 'string' ||
          !Array.isArray(data)
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const attachment = await client.createIssueAttachment(owner, repo, index, new Uint8Array(data), name);
          this._reply('issueAttachmentCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            // The numeric id is what the delete command needs; without it an
            // attachment uploaded into the editor could not be removed again.
            id: attachment.id,
            uuid: attachment.uuid,
            name: attachment.name,
            size: attachment.size,
            browser_download_url: attachment.browser_download_url,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createIssueAttachment failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueAttachmentCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'deleteIssueAttachment': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, attachmentId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof attachmentId !== 'number'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete attachment #{0} of issue #{1} in {2}?',
              attachmentId,
              index,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('issueAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            attachmentId,
            cancelled: true,
            _requestId: message._requestId,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteIssueAttachment(owner, repo, index, attachmentId);
          this._reply('issueAttachmentDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            attachmentId,
            _requestId: message._requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteIssueAttachment failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('issueAttachmentDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            attachmentId,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'getPullRequestDetail': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const detail = await client.getPullRequestDetail(owner, repo, index);
          const payload: Omit<Extract<HostToWebviewMessage, { command: 'pullRequestDetail' }>, 'command'> = {
            instanceId: instance.id,
            owner,
            repo,
            index,
            detail,
            // Sent beside `detail`, which is where the webview reads it from
            // (its stored detail then carries the flag into the view). Only on
            // failure: an empty `assets` list from a successful probe really is
            // "no attachments".
            ...(detail.attachmentsUnavailable === true ? { attachmentsUnavailable: true } : {}),
          };
          this._reply('pullRequestDetail', payload);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getPullRequestDetail failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestDetail', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'createPullRequest': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || !data || typeof data.title !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const item = await client.createPullRequest(owner, repo, data);
          this._reply('pullRequestCreated', {
            instanceId: instance.id,
            owner,
            repo,
            index: (item as { number?: number }).number ?? 0,
            item,
            _requestId: message._requestId,
          });
          this.onPullRequestsChanged?.();
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createPullRequest failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('pullRequestCreated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index: 0,
            error: err,
            _requestId: message._requestId,
          });
        }
        return;
      }
      case 'editPullRequest': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, data } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number' || !data) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const { state_toggle: stateToggle, due_date_update: dueDateUpdate, ...prData } = data;
          const item = await client.editPullRequest(owner, repo, index, prData);
          this._reply('pullRequestUpdated', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            item,
            ...(stateToggle ? { stateToggle: true } : {}),
            ...(dueDateUpdate ? { dueDateUpdate: true } : {}),
          });
          // Closing (or reopening) a PR changes the status bar's open-PR lookup.
          if (data.state) {
            this.onPullRequestsChanged?.();
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editPullRequest failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestUpdated', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
            ...(data.state_toggle ? { stateToggle: true } : {}),
            ...(data.due_date_update ? { dueDateUpdate: true } : {}),
          });
        }
        return;
      }
      case 'getPullRequestFiles': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, baseSha, headSha } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          let files: ForgejoChangedFile[];
          // The JSON file list, when it was already fetched: the compare call
          // falling back to it must not be followed by a second request for the
          // same page just to read the addition/deletion counts.
          let jsonFiles: ForgejoChangedFile[] | undefined;
          if (typeof baseSha === 'string' && typeof headSha === 'string') {
            try {
              files = await client.getPullRequestFilesFromCompare(owner, repo, baseSha, headSha);
              logger.info(
                `getPullRequestFilesFromCompare returned ${files.length} files for ${instance.name}/${owner}/${repo}#${index}`,
              );
            } catch (compareError) {
              const compareErr = compareError instanceof Error ? compareError.message : String(compareError);
              logger.info(
                `Falling back to JSON file list for ${instance.name}/${owner}/${repo}#${index}: ${compareErr}`,
              );
              jsonFiles = await client.getPullRequestFiles(owner, repo, index);
              files = jsonFiles;
            }
          } else {
            jsonFiles = await client.getPullRequestFiles(owner, repo, index);
            files = jsonFiles;
          }

          // Supplement additions/deletions counts from the JSON endpoint, reusing
          // the list already fetched above when there is one.
          try {
            const countsSource = jsonFiles ?? (await client.getPullRequestFiles(owner, repo, index));
            const countMap = new Map(countsSource.map((f) => [f.filename, f]));
            files = files.map((file) => {
              const counts = countMap.get(file.filename);
              if (!counts) {
                return file;
              }
              return {
                ...file,
                additions: counts.additions ?? file.additions,
                deletions: counts.deletions ?? file.deletions,
                changes: counts.changes ?? (counts.additions ?? 0) + (counts.deletions ?? 0),
              };
            });
          } catch (error) {
            // counts are optional
            logger.debug(
              `getPullRequestFiles count supplement failed for ${owner}/${repo}#${index}: ${userFacingErrorMessage(error)}`,
            );
          }

          logger.info(
            `getPullRequestFiles returned ${files.length} files for ${instance.name}/${owner}/${repo}#${index}`,
          );
          if (logger.isDebugEnabled()) {
            // Serialized only while debug logging is on: the whole changed-file
            // list is large enough for the stringify itself to be the cost.
            logger.debug(
              `getPullRequestFiles detail for ${instance.name}/${owner}/${repo}#${index}: ${JSON.stringify(
                files.map((f) => ({
                  filename: f.filename,
                  status: f.status,
                  additions: f.additions,
                  deletions: f.deletions,
                })),
              )}`,
            );
          }
          this._reply('pullRequestFiles', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            baseSha,
            headSha,
            files,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getPullRequestFiles failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestFiles', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            baseSha,
            headSha,
            error: err,
          });
        }
        return;
      }
      case 'getPullRequestCommentsAndTimeline': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const comments = await client.getPullRequestCommentsAndTimeline(owner, repo, index);
          this._reply('pullRequestCommentsAndTimeline', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            comments,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `getPullRequestCommentsAndTimeline failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`,
          );
          this._reply('pullRequestCommentsAndTimeline', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'getPullRequestCommits': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof index !== 'number') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const commits = await client.getPullRequestCommits(owner, repo, index);
          this._reply('pullRequestCommits', {
            instanceId: instance.id,
            owner,
            repo,
            index,
            commits,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getPullRequestCommits failed for ${instance.name}/${owner}/${repo}#${index}: ${err}`);
          this._reply('pullRequestCommits', {
            instanceId: message.instanceId,
            owner,
            repo,
            index,
            error: err,
          });
        }
        return;
      }
      case 'openPullRequestDiff': {
        const { instanceId, owner, repo, index, filename, status, previousFilename, baseSha, headSha } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof filename !== 'string' ||
          typeof status !== 'string' ||
          typeof baseSha !== 'string' ||
          typeof headSha !== 'string' ||
          // The filename reaches the contents-API route through the diff URI,
          // and previousFilename is used in its place for a renamed file, so
          // both get the same guard every sibling handler applies.
          !isSafeRepoPath(filename) ||
          (previousFilename !== undefined && previousFilename !== null && !isSafeRepoPath(previousFilename))
        ) {
          return;
        }
        try {
          // A renamed file only exists under its old path at the base ref.
          const basePath = status === 'renamed' && previousFilename ? previousFilename : filename;
          const baseUri = this._buildDiffUri(instanceId, owner, repo, index, baseSha, basePath, true, status);
          const headUri = this._buildDiffUri(instanceId, owner, repo, index, headSha, filename, false, status);
          const title = `${filename} (#${index})`;
          await vscode.commands.executeCommand('vscode.diff', baseUri, headUri, title);
          if (status === 'added') {
            vscode.window.showInformationMessage(
              vscode.l10n.t('This file was added in the pull request: {0}', filename),
            );
          } else if (status === 'removed') {
            vscode.window.showInformationMessage(
              vscode.l10n.t('This file was removed in the pull request: {0}', filename),
            );
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openPullRequestDiff failed for ${owner}/${repo}#${index} ${filename}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open diff: {0}', err));
        }
        return;
      }
      case 'openSelectedPullRequestDiffs': {
        const { instanceId, owner, repo, index, files, baseSha, headSha } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          !Array.isArray(files) ||
          typeof baseSha !== 'string' ||
          typeof headSha !== 'string'
        ) {
          return;
        }
        try {
          // The same path guard a sibling handler applies: a forged filename or
          // previous_filename reaches the contents-API route. `encodeFilePath`
          // neutralises most escape attempts, so this is defense in depth.
          const unsupported = files.some((file) => {
            if (typeof file === 'string') {
              return !isSafeRepoPath(file);
            }
            const candidate = file as { filename?: unknown; previous_filename?: unknown };
            if (!isSafeRepoPath(candidate.filename)) {
              return true;
            }
            return candidate.previous_filename !== undefined && candidate.previous_filename !== null
              ? !isSafeRepoPath(candidate.previous_filename)
              : false;
          });
          if (unsupported) {
            logger.error(`openSelectedPullRequestDiffs ignored: unsafe file path in the webview message`);
            return;
          }
          const resourceList = files.map((file) => {
            const filename = typeof file === 'string' ? file : file.filename;
            const status = typeof file === 'string' ? 'modified' : file.status;
            // A renamed file only exists under its old path at the base ref.
            const previousFilename = typeof file === 'string' ? undefined : file.previous_filename;
            const basePath = status === 'renamed' && previousFilename ? previousFilename : filename;
            const baseUri = this._buildDiffUri(instanceId, owner, repo, index, baseSha, basePath, true, status);
            const headUri = this._buildDiffUri(instanceId, owner, repo, index, headSha, filename, false, status);
            if (status === 'added') {
              return [headUri, undefined, headUri];
            }
            if (status === 'removed') {
              return [baseUri, baseUri, undefined];
            }
            return [headUri, baseUri, headUri];
          });
          const title = `${owner}/${repo}#${index}`;
          await vscode.commands.executeCommand('vscode.changes', title, resourceList);
          const addedCount = files.filter((file) =>
            typeof file === 'string' ? false : file.status === 'added',
          ).length;
          const removedCount = files.filter((file) =>
            typeof file === 'string' ? false : file.status === 'removed',
          ).length;
          if (addedCount > 0 && removedCount > 0) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Opening {0} added and {1} removed files from the pull request', addedCount, removedCount),
            );
          } else if (addedCount > 0) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Opening {0} added files from the pull request', addedCount),
            );
          } else if (removedCount > 0) {
            vscode.window.showInformationMessage(
              vscode.l10n.t('Opening {0} removed files from the pull request', removedCount),
            );
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openSelectedPullRequestDiffs failed for ${owner}/${repo}#${index}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open selected diffs: {0}', err));
        }
        return;
      }
      case 'getRepoIssues': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issues = await client.getRepoIssues(owner, repo, message.state ?? 'open', message.query);
          this._reply('repoIssues', {
            instanceId: instance.id,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            issues: issues.items,
            ...(issues.totalCount !== undefined ? { totalCount: issues.totalCount } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoIssues failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoIssues', {
            instanceId: message.instanceId,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            error: err,
          });
        }
        return;
      }
      case 'getRepoLabels': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const labels = await client.getRepoLabels(owner, repo);
          this._reply('repoLabels', { instanceId: instance.id, owner, repo, labels });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoLabels failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoLabels', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'getRepoAssignees': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const assignees = await client.getRepoAssignees(owner, repo);
          this._reply('repoAssignees', { instanceId: instance.id, owner, repo, assignees });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoAssignees failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoAssignees', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'getRepoMilestones': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const milestones = await client.getRepoMilestones(owner, repo);
          this._reply('repoMilestones', { instanceId: instance.id, owner, repo, milestones });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoMilestones failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoMilestones', { instanceId: message.instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'searchMentions': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, query, type, _requestId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof query !== 'string' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const result = await client.searchMentions(owner, repo, query, type as 'user' | 'issue' | 'all');
          this._reply('mentionSearchResult', { _requestId, users: result.users, issues: result.issues });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`searchMentions failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('mentionSearchResult', { _requestId, error: err });
        }
        return;
      }
      case 'getUserPreview': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { username, _requestId } = message;
        // `username` is interpolated into `/users/${username}`: without this the
        // host would issue an arbitrary authenticated GET for a forged value and
        // hand the body back to the webview.
        if (!isSafeRepoNameSegment(username) || typeof _requestId !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const user = await client.getUserPreview(username);
          this._reply('userPreviewResult', { _requestId, user });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getUserPreview failed for ${instance.name}/${username}: ${err}`);
          this._reply('userPreviewResult', { _requestId, error: err });
        }
        return;
      }
      case 'getIssuePreview': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, index, _requestId } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof index !== 'number' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const issue = await client.getIssuePreview(owner, repo, index);
          this._reply('issuePreviewResult', { _requestId, issue });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getIssuePreview failed for ${instance.name}/${owner}/${repo}/${index}: ${err}`);
          this._reply('issuePreviewResult', { _requestId, error: err });
        }
        return;
      }
      case 'getRepoPullRequests': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const pullRequests = await client.getRepoPullRequests(owner, repo, message.state ?? 'open', message.query);
          this._reply('repoPullRequests', {
            instanceId: instance.id,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            pullRequests: pullRequests.items,
            ...(pullRequests.totalCount !== undefined ? { totalCount: pullRequests.totalCount } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoPullRequests failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('repoPullRequests', {
            instanceId: message.instanceId,
            owner,
            repo,
            state: message.state ?? 'open',
            query: message.query,
            error: err,
          });
        }
        return;
      }
      case 'getActionRuns': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string') {
          // The runs view clears its loading gate only on an `actionRuns`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionRuns', vscode.l10n.t('The request could not be completed'));
          return;
        }
        const page = typeof message.page === 'number' ? message.page : 1;
        const limit = typeof message.limit === 'number' ? message.limit : 30;
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const result = await client.listActionRuns(owner, repo, page, limit);
          this._reply('actionRuns', {
            instanceId: instance.id,
            owner,
            repo,
            page,
            actionRuns: result.workflow_runs ?? [],
            totalCount: result.total_count ?? 0,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRuns failed for ${instance.name}/${owner}/${repo}: ${err}`);
          this._reply('actionRuns', {
            instanceId: message.instanceId,
            owner,
            repo,
            page: typeof message.page === 'number' ? message.page : 1,
            error: err,
          });
        }
        return;
      }
      case 'getActionRun': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          // The detail view clears its loading gate only on an `actionRun`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionRun', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const run = await client.getActionRun(owner, repo, runId);
          this._reply('actionRun', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            run,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRun failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRun', { instanceId: message.instanceId, owner, repo, runId, error: err });
        }
        return;
      }
      case 'getActionRunJobs': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          // The jobs list clears its loading gate only on an `actionRunJobs`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionRunJobs', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const jobs = await client.getActionRunJobs(owner, repo, runId);
          this._reply('actionRunJobs', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            jobs,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRunJobs failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunJobs', { instanceId: message.instanceId, owner, repo, runId, error: err });
        }
        return;
      }
      case 'getActionRunArtifacts': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          // The artifacts list clears its loading gate only on an
          // `actionRunArtifacts` reply, and this message carries no
          // `_requestId`.
          this._replyResultShapedError(
            message,
            'actionRunArtifacts',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const artifacts = await client.getActionRunArtifacts(owner, repo, runId);
          this._reply('actionRunArtifacts', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            artifacts,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionRunArtifacts failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunArtifacts', { instanceId: message.instanceId, owner, repo, runId, error: err });
        }
        return;
      }
      case 'getActionJobLog': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, jobId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof jobId !== 'number') {
          // The log view clears its loading gate only on an `actionJobLog`
          // reply, and this message carries no `_requestId`.
          this._replyResultShapedError(message, 'actionJobLog', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const log = await client.getActionJobLog(owner, repo, jobId);
          this._reply('actionJobLog', {
            instanceId: instance.id,
            owner,
            repo,
            jobId,
            log,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getActionJobLog failed for ${instance.name}/${owner}/${repo}/jobs/${jobId}: ${err}`);
          this._reply('actionJobLog', { instanceId: message.instanceId, owner, repo, jobId, error: err });
        }
        return;
      }
      case 'getWorkflowDispatchInputs': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, workflow, ref } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof workflow !== 'string' ||
          typeof ref !== 'string'
        ) {
          // The form waits on a result-shaped reply to leave its "reading the
          // declared inputs" state, so a rejected request is answered rather
          // than dropped.
          this._replyResultShapedError(
            message,
            'workflowDispatchInputs',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          // Every outcome is a fallback, not an error: the form keeps its raw
          // key/value editor for a workflow that declares nothing and for a
          // file that could not be read or parsed, so `reason` — not a thrown
          // error — is what the view switches on.
          const result = await readWorkflowDispatchInputs(client, owner, repo, workflow, ref);
          if (result.status === 'ok') {
            this._reply('workflowDispatchInputs', {
              instanceId: instance.id,
              owner,
              repo,
              workflow,
              ref,
              inputs: result.inputs,
              path: result.path,
            });
          } else if (result.status === 'no-inputs') {
            this._reply('workflowDispatchInputs', {
              instanceId: instance.id,
              owner,
              repo,
              workflow,
              ref,
              path: result.path,
              reason: 'no-inputs',
            });
          } else {
            this._reply('workflowDispatchInputs', {
              instanceId: instance.id,
              owner,
              repo,
              workflow,
              ref,
              reason: 'unreadable',
              ...(result.path !== undefined ? { path: result.path } : {}),
              error: result.error,
            });
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(
            `getWorkflowDispatchInputs failed for ${instance.name}/${owner}/${repo}/${workflow}@${ref}: ${err}`,
          );
          this._reply('workflowDispatchInputs', {
            instanceId: message.instanceId,
            owner,
            repo,
            workflow,
            ref,
            reason: 'unreadable',
            error: err,
          });
        }
        return;
      }
      case 'dispatchWorkflow': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, workflowfilename, ref, inputs } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof workflowfilename !== 'string' ||
          typeof ref !== 'string'
        ) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Run workflow "{0}" on ref "{1}" in {2}?',
              workflowfilename,
              ref,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('actionRunDispatched', {
            instanceId: instance.id,
            owner,
            repo,
            workflowfilename,
            cancelled: true,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const run = await client.dispatchWorkflow(
            owner,
            repo,
            workflowfilename,
            ref,
            inputs && typeof inputs === 'object' ? (inputs as Record<string, string>) : undefined,
          );
          this._reply('actionRunDispatched', {
            instanceId: instance.id,
            owner,
            repo,
            workflowfilename,
            accepted: true,
            run,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`dispatchWorkflow failed for ${instance.name}/${owner}/${repo}/${workflowfilename}: ${err}`);
          this._reply('actionRunDispatched', {
            instanceId: message.instanceId,
            owner,
            repo,
            workflowfilename,
            error: err,
          });
        }
        return;
      }
      case 'cancelActionRun': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Cancel run #{0} in {1}? In-progress jobs will be stopped.',
              runId,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('actionRunCancelled', { instanceId: instance.id, owner, repo, runId, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.cancelActionRun(owner, repo, runId);
          this._reply('actionRunCancelled', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            success: true,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`cancelActionRun failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunCancelled', {
            instanceId: message.instanceId,
            owner,
            repo,
            runId,
            error: err,
          });
        }
        return;
      }
      case 'deleteActionRun': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, runId } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || typeof runId !== 'number') {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete run #{0} in {1}? This cannot be undone.',
              runId,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('actionRunDeleted', { instanceId: instance.id, owner, repo, runId, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteActionRun(owner, repo, runId);
          this._reply('actionRunDeleted', {
            instanceId: instance.id,
            owner,
            repo,
            runId,
            success: true,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteActionRun failed for ${instance.name}/${owner}/${repo}/${runId}: ${err}`);
          this._reply('actionRunDeleted', {
            instanceId: message.instanceId,
            owner,
            repo,
            runId,
            error: err,
          });
        }
        return;
      }
      case 'downloadActionArtifact': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, artifactId, name } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof artifactId !== 'number' ||
          typeof name !== 'string'
        ) {
          return;
        }
        try {
          // The artifact name is webview-supplied and lands in the save
          // dialog's default path: without stripping any directory part a
          // hostile name (`../../.ssh/authorized_keys` or `/etc/cron.d/x`)
          // would pre-fill an arbitrary location and one Enter would write
          // there. Taking the last segment of either separator (rather than
          // `path.basename`, whose treatment of `\` is platform-dependent)
          // leaves only the file name; the `.zip` extension the filter expects
          // is preserved.
          const safeName = name.split(/[\\/]/).pop() || `artifact-${artifactId}.zip`;
          const defaultName = safeName.endsWith('.zip') ? safeName : `${safeName}.zip`;
          const uri = await vscode.window.showSaveDialog({
            defaultUri: vscode.Uri.file(defaultName),
            filters: { 'ZIP Archive': ['zip'] },
          });
          if (!uri) {
            this._reply('actionArtifactDownloaded', {
              instanceId: message.instanceId,
              owner,
              repo,
              artifactId,
              cancelled: true,
            });
            return;
          }
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          // The artifact streams straight to disk (no 50 MB memory cap), so
          // report progress while it downloads.
          await vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t('Downloading artifact {0}…', defaultName),
            },
            (progress) =>
              client.downloadActionArtifactToFile(owner, repo, artifactId, uri.fsPath, (bytesWritten) => {
                progress.report({
                  message: vscode.l10n.t('{0} MB downloaded', (bytesWritten / (1024 * 1024)).toFixed(1)),
                });
              }),
          );
          this._reply('actionArtifactDownloaded', {
            instanceId: instance.id,
            owner,
            repo,
            artifactId,
            path: uri.fsPath,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`downloadActionArtifact failed for ${instance.name}/${owner}/${repo}/${artifactId}: ${err}`);
          this._reply('actionArtifactDownloaded', {
            instanceId: message.instanceId,
            owner,
            repo,
            artifactId,
            error: err,
          });
        }
        return;
      }
      case 'renderMarkdown': {
        const { text, _requestId } = message;
        const instance = this._findInstance(message.instanceId);
        // Early returns are safe for requests carrying a _requestId: the
        // dispatch wrapper answers them with a generic requestError.
        if (!instance || typeof text !== 'string' || typeof _requestId !== 'string') {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const html = await client.renderMarkdown(text, message.context);
          const htmlWithResolvedImages = await resolveAttachmentImages(html, instance);
          this._reply('renderedMarkdown', { _requestId, html: htmlWithResolvedImages });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`renderMarkdown failed for ${instance.name}: ${err}`);
          this._reply('renderedMarkdown', { _requestId, error: err });
        }
        return;
      }
      case 'getRepoContents': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, path, ref } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          // The path is interpolated into the contents route; a `..` segment would
          // let the URL parser walk out of it and reach another API endpoint.
          !isSafeRepoPath(path) ||
          typeof ref !== 'string'
        ) {
          // The file browser keys its loading gate on the identity it sent and
          // only a `repoContents` reply clears it. This message carries no
          // `_requestId`, so the dispatch fallback cannot answer it: reply with
          // the same shape as the error path below instead of dropping it.
          // The fields are echoed verbatim (not normalized) because the loader
          // keys its gate on the raw values: `RepoDetail.vue` forwards an
          // unnormalised `default_branch`, so a missing `ref` arrives as
          // `undefined` and a `''` substitute would clear a different key.
          this._replyResultShapedError(message, 'repoContents', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          // The entries are forwarded as the API returned them. The webview's
          // file browser only renders name/path/type/size and opens files
          // through openRepoFile → repoFileProvider, which is where a withheld
          // payload (files above `[api] DEFAULT_MAX_BLOB_SIZE`) gets its
          // explanation — with the entry-type check that keeps symlinks and
          // submodules from being misread as withheld files.
          const entries = await client.getRepoContents(owner, repo, path, ref || undefined);
          if (logger.isDebugEnabled()) {
            // Debug logging is off by default, and a directory can hold
            // thousands of entries: the stringify of every name/path/type must
            // not be paid for a line the logger is about to drop.
            logger.debug(
              `getRepoContents returned ${entries.length} entries for ${instance.name}/${owner}/${repo}/${path}@${ref}: ${JSON.stringify(entries.map((e) => ({ name: e.name, path: e.path, type: e.type })))}`,
            );
          }
          this._reply('repoContents', {
            instanceId: instance.id,
            owner,
            repo,
            ref,
            path,
            entries,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoContents failed for ${instance.name}/${owner}/${repo}/${path}: ${err}`);
          this._reply('repoContents', {
            instanceId: message.instanceId,
            owner,
            repo,
            ref,
            path,
            error: err,
          });
        }
        return;
      }
      case 'openRepoFile': {
        const { instanceId, owner, repo, path, ref } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          !isSafeRepoPath(path) ||
          typeof ref !== 'string'
        ) {
          // This message carries no `_requestId`, so the dispatch fallback
          // cannot answer it; the handler's error contract is a visible message
          // rather than a reply.
          vscode.window.showErrorMessage(vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const uri = buildRepoFileUri({ instanceId, owner, repo, ref, path });
          await vscode.commands.executeCommand('vscode.open', uri, { preview: false });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openRepoFile failed for ${owner}/${repo}/${path}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open file: {0}', err));
        }
        return;
      }
      case 'searchRepoFiles': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, ref, query } = message;
        if (
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof ref !== 'string' ||
          typeof query !== 'string'
        ) {
          // The file-search view only clears its loading gate on a
          // `repoFilesSearchResult` reply and this message carries no
          // `_requestId`, so the dispatch fallback cannot answer it.
          this._replyResultShapedError(
            message,
            'repoFilesSearchResult',
            vscode.l10n.t('The request could not be completed'),
          );
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const { files, truncated, truncatedBy } = await client.searchRepoFiles(owner, repo, ref, query);
          if (truncated) {
            // Name the cause the client reported: an unreadable tree means
            // matches are missing and no query recovers them, while a hit cap
            // means a narrower query returns the rest. Naming the wrong cause
            // either promises a narrowing that cannot help or hides the one that
            // would.
            logger.info(
              truncatedBy === 'matches'
                ? `searchRepoFiles for ${owner}/${repo}@${ref} hit the match cap; the list is incomplete`
                : `searchRepoFiles for ${owner}/${repo}@${ref} ran over a tree that could not be read completely`,
            );
          }
          this._reply('repoFilesSearchResult', {
            instanceId: instance.id,
            owner,
            repo,
            ref,
            query,
            files,
            truncated,
            // Only alongside a truncation: the contract documents that a
            // consumer seeing the flag on a complete answer must not promise a
            // narrower query recovers anything (see the message type). A host
            // built from an older client has no cause to name, so the reason is
            // forwarded only when the client reported one.
            ...(truncated && truncatedBy ? { truncatedBy } : {}),
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`searchRepoFiles failed for ${owner}/${repo}@${ref}: ${err}`);
          this._reply('repoFilesSearchResult', {
            instanceId: message.instanceId,
            owner,
            repo,
            ref,
            query,
            error: err,
          });
        }
        return;
      }
      case 'getFileHistory': {
        const instance = this._findInstance(message.instanceId);
        if (!instance) {
          return;
        }
        const { owner, repo, path, ref } = message;
        if (typeof owner !== 'string' || typeof repo !== 'string' || !isSafeRepoPath(path) || typeof ref !== 'string') {
          // Same reasoning as getRepoContents: the history view only clears its
          // loading gate on a `fileHistory` reply and this message carries no
          // `_requestId` for the dispatch fallback to answer. The fields are
          // echoed verbatim so the reply lands on the key the loader set, even
          // when `ref`/`path` are missing.
          this._replyResultShapedError(message, 'fileHistory', vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const commits = await client.getFileHistory(owner, repo, path, ref);
          this._reply('fileHistory', {
            instanceId: instance.id,
            owner,
            repo,
            path,
            ref,
            commits,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getFileHistory failed for ${owner}/${repo}/${path}@${ref}: ${err}`);
          this._reply('fileHistory', {
            instanceId: message.instanceId,
            owner,
            repo,
            path,
            ref,
            error: err,
          });
        }
        return;
      }
      case 'openRepoFileDiff': {
        const { instanceId, owner, repo, path, baseRef, headRef } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          !isSafeRepoPath(path) ||
          typeof baseRef !== 'string' ||
          typeof headRef !== 'string'
        ) {
          // Same reasoning as openRepoFile: no `_requestId` to answer, so the
          // rejection has to reach the user through the handler's own contract.
          vscode.window.showErrorMessage(vscode.l10n.t('The request could not be completed'));
          return;
        }
        try {
          const leftUri = buildRepoFileUri({ instanceId, owner, repo, ref: baseRef, path });
          const rightUri = buildRepoFileUri({ instanceId, owner, repo, ref: headRef, path });
          await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, `${path} (${baseRef}..${headRef})`);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openRepoFileDiff failed for ${owner}/${repo}/${path}: ${err}`);
          vscode.window.showErrorMessage(vscode.l10n.t('Unable to open diff: {0}', err));
        }
        return;
      }
      case 'getRepoRefs': {
        const { instanceId, owner, repo } = message;
        if (typeof instanceId !== 'string' || typeof owner !== 'string' || typeof repo !== 'string') {
          // The refs view only clears its loading gate on a `repoRefs` reply and
          // this message carries no `_requestId`, so the dispatch fallback
          // cannot answer it.
          this._replyResultShapedError(message, 'repoRefs', vscode.l10n.t('The request could not be completed'));
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const [branches, tags, releases] = await Promise.all([
            client.getRepoBranches(owner, repo),
            client.getRepoTags(owner, repo),
            client.getRepoReleases(owner, repo),
          ]);
          this._reply('repoRefs', { instanceId, owner, repo, branches, tags, releases });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`getRepoRefs failed for ${owner}/${repo}: ${err}`);
          this._reply('repoRefs', { instanceId, owner, repo, error: err });
        }
        return;
      }
      case 'createRepoBranch': {
        const { instanceId, owner, repo, newBranchName, oldRefName } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof newBranchName !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const oldRef = typeof oldRefName === 'string' ? oldRefName : undefined;
          await client.createBranch(owner, repo, { new_branch_name: newBranchName, old_ref_name: oldRef });
          this._reply('repoBranchCreated', { instanceId, owner, repo, branch: newBranchName });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createRepoBranch failed for ${owner}/${repo}/${newBranchName}: ${err}`);
          this._reply('repoBranchCreated', { instanceId, owner, repo, branch: newBranchName, error: err });
        }
        return;
      }
      case 'deleteRepoBranch': {
        const { instanceId, owner, repo, branch } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof branch !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete branch "{0}" in {1}?', branch, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('repoBranchDeleted', { instanceId, owner, repo, branch, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteBranch(owner, repo, branch);
          this._reply('repoBranchDeleted', { instanceId, owner, repo, branch });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteRepoBranch failed for ${owner}/${repo}/${branch}: ${err}`);
          this._reply('repoBranchDeleted', { instanceId, owner, repo, branch, error: err });
        }
        return;
      }
      case 'createRepoTag': {
        const { instanceId, owner, repo, tagName, target, message: tagMessage } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof tagName !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.createTag(owner, repo, {
            tag_name: tagName,
            target: typeof target === 'string' ? target : undefined,
            message: typeof tagMessage === 'string' ? tagMessage : undefined,
          });
          this._reply('repoTagCreated', { instanceId, owner, repo, tag: tagName });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createRepoTag failed for ${owner}/${repo}/${tagName}: ${err}`);
          this._reply('repoTagCreated', { instanceId, owner, repo, tag: tagName, error: err });
        }
        return;
      }
      case 'deleteRepoTag': {
        const { instanceId, owner, repo, tag } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof tag !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete tag "{0}" in {1}?', tag, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('repoTagDeleted', { instanceId, owner, repo, tag, cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteTag(owner, repo, tag);
          this._reply('repoTagDeleted', { instanceId, owner, repo, tag });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteRepoTag failed for ${owner}/${repo}/${tag}: ${err}`);
          this._reply('repoTagDeleted', { instanceId, owner, repo, tag, error: err });
        }
        return;
      }
      case 'createRepoRelease': {
        const {
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
        } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof tagName !== 'string' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const release = await client.createRelease(owner, repo, {
            tag_name: tagName,
            name: typeof name === 'string' ? name : undefined,
            body: typeof body === 'string' ? body : undefined,
            target_commitish: typeof targetCommitish === 'string' ? targetCommitish : undefined,
            prerelease: typeof prerelease === 'boolean' ? prerelease : undefined,
            draft: typeof draft === 'boolean' ? draft : undefined,
            hide_archive_links: typeof hideArchiveLinks === 'boolean' ? hideArchiveLinks : undefined,
          });
          this._reply('repoReleaseCreated', {
            instanceId,
            owner,
            repo,
            release: tagName,
            item: release,
            _requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createRepoRelease failed for ${owner}/${repo}/${tagName}: ${err}`);
          this._reply('repoReleaseCreated', {
            instanceId,
            owner,
            repo,
            release: tagName,
            error: err,
            _requestId,
          });
        }
        return;
      }
      case 'deleteRepoRelease': {
        const { instanceId, owner, repo, id } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t('Delete release #{0} in {1}?', id, confirmInstanceScope(instance, owner, repo)),
          ))
        ) {
          this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id), cancelled: true });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteRelease(owner, repo, id);
          this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id) });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteRepoRelease failed for ${owner}/${repo}/${id}: ${err}`);
          this._reply('repoReleaseDeleted', { instanceId, owner, repo, release: String(id), error: err });
        }
        return;
      }
      case 'editRepoRelease': {
        const { instanceId, owner, repo, id, data } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number' ||
          !data ||
          typeof data !== 'object'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.editRelease(owner, repo, id, {
            tag_name: typeof data.tag_name === 'string' ? data.tag_name : undefined,
            name: typeof data.name === 'string' ? data.name : undefined,
            body: typeof data.body === 'string' ? data.body : undefined,
            target_commitish: typeof data.target_commitish === 'string' ? data.target_commitish : undefined,
            prerelease: typeof data.prerelease === 'boolean' ? data.prerelease : undefined,
            draft: typeof data.draft === 'boolean' ? data.draft : undefined,
            hide_archive_links: typeof data.hide_archive_links === 'boolean' ? data.hide_archive_links : undefined,
          });
          this._reply('repoReleaseEdited', { instanceId, owner, repo, release: String(id) });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`editRepoRelease failed for ${owner}/${repo}/${id}: ${err}`);
          this._reply('repoReleaseEdited', { instanceId, owner, repo, release: String(id), error: err });
        }
        return;
      }
      case 'createReleaseAttachment': {
        const { instanceId, owner, repo, id, name, data, _requestId } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number' ||
          typeof name !== 'string' ||
          !Array.isArray(data) ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          const file = new Uint8Array(data);
          const attachment = await client.createReleaseAttachment(owner, repo, id, file, name);
          this._reply('releaseAttachmentCreated', {
            instanceId,
            owner,
            repo,
            id,
            attachment,
            _requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`createReleaseAttachment failed for ${owner}/${repo}/releases/${id}: ${err}`);
          this._reply('releaseAttachmentCreated', {
            instanceId,
            owner,
            repo,
            id,
            error: err,
            _requestId,
          });
        }
        return;
      }
      case 'deleteReleaseAttachment': {
        const { instanceId, owner, repo, id, attachmentId, _requestId } = message;
        if (
          typeof instanceId !== 'string' ||
          typeof owner !== 'string' ||
          typeof repo !== 'string' ||
          typeof id !== 'number' ||
          typeof attachmentId !== 'number' ||
          typeof _requestId !== 'string'
        ) {
          return;
        }
        const instance = this._findInstance(instanceId);
        if (!instance) {
          return;
        }
        if (
          !(await this._confirmDestructive(
            vscode.l10n.t(
              'Delete attachment #{0} of release #{1} in {2}?',
              attachmentId,
              id,
              confirmInstanceScope(instance, owner, repo),
            ),
          ))
        ) {
          this._reply('releaseAttachmentDeleted', {
            instanceId,
            owner,
            repo,
            id,
            attachmentId,
            cancelled: true,
            _requestId,
          });
          return;
        }
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          await client.deleteReleaseAttachment(owner, repo, id, attachmentId);
          this._reply('releaseAttachmentDeleted', {
            instanceId,
            owner,
            repo,
            id,
            attachmentId,
            _requestId,
          });
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`deleteReleaseAttachment failed for ${owner}/${repo}/releases/${id}/${attachmentId}: ${err}`);
          this._reply('releaseAttachmentDeleted', {
            instanceId,
            owner,
            repo,
            id,
            attachmentId,
            error: err,
            _requestId,
          });
        }
        return;
      }
      case 'showInputBox': {
        const { id, prompt, value, placeHolder } = message;
        if (typeof id !== 'string' || typeof prompt !== 'string') {
          return;
        }
        const result = await vscode.window.showInputBox({
          prompt,
          value: typeof value === 'string' ? value : undefined,
          placeHolder: typeof placeHolder === 'string' ? placeHolder : undefined,
          ignoreFocusOut: true,
        });
        this._reply('showInputBoxResult', { id, value: result ?? undefined, cancelled: result === undefined });
        return;
      }
      case 'showConfirm': {
        const { id, message: confirmMessage, confirmLabel } = message;
        if (typeof id !== 'string' || typeof confirmMessage !== 'string' || typeof confirmLabel !== 'string') {
          return;
        }
        const result = await vscode.window.showInformationMessage(confirmMessage, { modal: true }, confirmLabel);
        this._reply('showConfirmResult', { id, confirmed: result === confirmLabel });
        return;
      }
      case 'copyToClipboard': {
        const text = message.text;
        if (typeof text === 'string') {
          await vscode.env.clipboard.writeText(text);
          vscode.window.showInformationMessage(vscode.l10n.t('Copied to clipboard'));
        }
        return;
      }
      case 'previewReadme': {
        const { owner, repo, content, instanceId } = message;
        if (typeof owner === 'string' && typeof repo === 'string' && typeof content === 'string') {
          // The instance id keys the virtual document: two instances hosting the
          // same owner/repo must not share (and overwrite) one README document.
          openReadmePreview(
            this._readmeProvider,
            owner,
            repo,
            content,
            typeof instanceId === 'string' ? instanceId : undefined,
          );
        }
        return;
      }
      case 'openPrWorktree': {
        await this._handleOpenPrWorktree(message);
        return;
      }
      case 'startWorkOnIssue': {
        await this._handleStartWorkOnIssue(message);
        return;
      }
      case 'removeWorktree': {
        const { id } = message;
        if (typeof id === 'string') {
          // Double-click/double-submit guard, keyed on the same identity
          // dimension as openPrWorktree/startWorkOnIssue. The `remove:` prefix
          // keeps it a separate entry: InFlightTasks reuses the in-flight
          // promise, so sharing the exact open key would silently drop a
          // legitimate remove that races an open (and vice versa) without any
          // reply reaching the webview.
          const record = this._worktreeManager.getWorktree(id);
          const key = record
            ? record.kind === 'issue'
              ? `remove:start-work:${record.instanceId}:${record.owner}/${record.repo}#${record.prIndex}`
              : `remove:${record.instanceId}:${record.owner}/${record.repo}#${record.prIndex}`
            : `remove:${id}`;
          await this._worktreeInFlight.run(key, async () => {
            if (!record) {
              // The row names a record the host no longer tracks (its instance
              // may have been removed, which forgets its records). There is
              // nothing to delete and no path to delete it from, so answering
              // `worktreeRemoved` would tell the user the checkout is gone while
              // it is still on disk. Report why nothing happened, refresh the
              // list so the stale row disappears, and skip the prompt: there is
              // nothing to confirm.
              this._reply('worktreeError', {
                error: vscode.l10n.t(
                  'This worktree is no longer tracked by the extension, so nothing was deleted. Its directory, if it still exists, was left on disk; the list has been refreshed.',
                ),
                operation: 'remove',
              });
              this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
              return;
            }
            // Removing a worktree deletes the local directory and any work it
            // holds, so like every other destructive prompt it names its target.
            // The scope is data (instance name and owner/repo), composed around
            // the translated sentence; a missing instance record leaves the
            // prompt unscoped rather than blocking a local cleanup.
            const scope = `${confirmInstanceScope(this._findInstance(record.instanceId) ?? { name: record.instanceId }, record.owner, record.repo)}: `;
            // The confirmation lives inside the guard (same reasoning as
            // mergePullRequest). The webview tracks no pending state for
            // removeWorktree, so a decline needs no reply: the record and
            // the worktrees list simply stay as they are.
            if (
              !(await this._confirmDestructive(
                `${scope}${vscode.l10n.t(
                  'Delete this worktree? The local directory will be permanently deleted (not moved to the recycle bin) and any uncommitted changes will be lost.',
                )}`,
              ))
            ) {
              return;
            }
            try {
              // Another window may have removed the record since the lookup
              // above; the result says whether anything was actually deleted, so
              // a success is never reported for a removal that did not happen.
              const removed = await this._worktreeManager.removeWorktree(id);
              if (removed) {
                this._reply('worktreeRemoved', { id });
              } else {
                this._reply('worktreeError', {
                  error: vscode.l10n.t(
                    'This worktree is no longer tracked by the extension, so nothing was deleted. Its directory, if it still exists, was left on disk; the list has been refreshed.',
                  ),
                  operation: 'remove',
                });
              }
            } catch (error) {
              // removeWorktree keeps the record on failure so the user can
              // retry; the error reaches the user exactly once, through this
              // worktreeError notification shown by the webview.
              const err = userFacingErrorMessage(error);
              const failedRecord = this._worktreeManager.getWorktree(id);
              this._reply('worktreeError', {
                error: err,
                operation: 'remove',
                instanceId: failedRecord?.instanceId,
                owner: failedRecord?.owner,
                repo: failedRecord?.repo,
                index: failedRecord?.prIndex,
              });
            }
            this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
          });
        }
        return;
      }
      case 'setWorktreeOpenMode': {
        const mode = message.mode;
        if (mode === 'ask' || mode === 'currentWindow' || mode === 'newWindow') {
          await this._config.setWorktreeOpenMode(mode);
          this._reply('worktreeOpenMode', { mode });
        }
        return;
      }
      case 'setWorktreeCacheDirectory': {
        const directory = message.directory;
        if (typeof directory === 'string') {
          if (!(await this._setWorktreeCacheDirectory(directory))) {
            return;
          }
          this._reply('worktreeCacheDirectory', {
            directory: this._config.getWorktreeCacheDirectory() ?? '',
            defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
          });
        }
        return;
      }
      case 'browseWorktreeCacheDirectory': {
        const result = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: vscode.l10n.t('Select Cache Directory'),
        });
        if (result && result.length > 0) {
          const directory = result[0].fsPath;
          if (!(await this._setWorktreeCacheDirectory(directory))) {
            return;
          }
          this._reply('worktreeCacheDirectory', {
            directory: this._config.getWorktreeCacheDirectory() ?? '',
            defaultDirectory: this._config.getDefaultWorktreeCacheDirectory(),
          });
        }
        return;
      }
      case 'openOnboardingPanel': {
        vscode.commands.executeCommand('forgejoToolkit.openOnboarding');
        return;
      }
    }
  }

  /** Whether the import preview's plaintext-token stash is still held. Exported for tests. */
  public hasPendingImportInstancesForTest(): boolean {
    return this._pendingImportInstances !== undefined;
  }

  /**
   * Whether the parsed AI section of the previewed import file is still held.
   *
   * Exported for tests so a case can assert what the stash does *not* keep: the
   * credentials it carries are exactly the value that must not outlive a confirmed,
   * cancelled or disposed preview.
   */
  public hasPendingImportAiForTest(): boolean {
    return this._pendingImportAi !== undefined;
  }

  /**
   * Hands the provider the function that runs an AI pre-review, so the
   * `aiPreReviewPullRequest` message starts exactly the flow
   * `COMMAND_AI_PRE_REVIEW` starts (see `_aiPreReviewRunner` for why it is a
   * callback rather than an import).
   *
   * Called once by `registerAiPreReviewCommand`, the same place the command
   * handlers are registered, so both entries are wired together or neither is.
   */
  public setAiPreReviewRunner(runner: (target: PullRequestTarget) => void): void {
    this._aiPreReviewRunner = runner;
  }

  /**
   * Hands the provider the function that drafts a pull request description, so the
   * create-pull-request form's action runs exactly the flow
   * `COMMAND_GENERATE_PR_DESCRIPTION` names.
   *
   * Called once by `registerPrDescriptionCommand`, the same place the command
   * handler is registered, so both entries are wired together or neither is. The
   * callback's answer is what the form renders: this provider never writes a body,
   * a setting or a pull request on its behalf.
   */
  public setPrDescriptionRunner(
    runner: (target: {
      instanceId: string;
      owner: string;
      repo: string;
      base: string;
      head: string;
      title?: string;
    }) => Promise<{ kind: 'ok'; description: string } | { kind: 'cancelled' } | { kind: 'failed'; error: string }>,
  ): void {
    this._prDescriptionRunner = runner;
  }

  /**
   * Opens the settings page (`docs/design/settings-page.md` §9.3).
   *
   * It is an **editor-area tab** now, not a route inside this sidebar: the page
   * is a wide form and the sidebar is a column for lists, so the command (and
   * the view-title action that runs it) opens the tab, and opening it again
   * reveals the one already open rather than stacking a second. The sidebar is
   * deliberately **not** revealed or focused here — the page no longer lives in
   * it, and a settings command that replaced what the user was reading in the
   * sidebar would be the disturbance this move removes.
   */
  public openSettings() {
    SettingsWebviewPanel.createOrShow(this._extensionUri, {
      dispatchSettingsMessage: (message, reply) => this.dispatchSettingsMessage(message, reply),
      instanceUrls: () => this._config.getInstances().map((instance) => instance.url),
      locale: () => settingsLocale(),
    });
  }

  /**
   * Handles one message from the settings tab with replies routed back to it.
   *
   * It is the *same* dispatcher the sidebar uses, deliberately: the page sends
   * the messages the sidebar version sent, and a second switch statement for the
   * panel would be a second implementation of every one of them. What this adds
   * is the channel (`_replySink`), so a reply lands in the webview that asked
   * even when both are open.
   */
  public async dispatchSettingsMessage(message: unknown, reply: WebviewReplySink): Promise<void> {
    await this._replySink.run(reply, () => this._dispatchMessage(message));
  }

  public openDashboard() {
    this._revealView();
    this._postOrQueue({ command: 'openDashboard' });
  }

  /**
   * Bring the sidebar view on screen before messaging it. Commands like
   * "Open Settings" used to silently no-op when the view had never been
   * resolved; focusing the view id forces VS Code to resolve it, and the
   * queued message reaches the webview once it mounts.
   */
  private _revealView() {
    if (this._view) {
      this._view.show(false);
    } else {
      void vscode.commands.executeCommand('forgejoToolkitView.focus');
    }
  }

  public openCreatePullRequest(payload: { instanceId: string; owner: string; repo: string; head: string }) {
    this._postOrQueue({ command: 'openCreatePullRequest', ...payload });
  }

  public openNewIssue(payload: { instanceId: string; owner: string; repo: string; title?: string; body?: string }) {
    this._postOrQueue({ command: 'openNewIssue', ...payload });
  }

  public openPullRequestDetail(payload: { instanceId: string; owner: string; repo: string; index: number }) {
    this._postOrQueue({ command: 'openPullRequestDetail', ...payload });
  }

  /**
   * Brings the sidebar on screen and opens one pull request's detail there.
   *
   * `openPullRequestDetail` alone is for a caller the user is already looking at
   * (the dashboard itself); this one reveals the view first, which is what an
   * action taken from a **separate** editor tab needs — the AI pre-review
   * panel's "open the pull request" button after drafts were created. Without
   * the reveal the message would be queued into a view that is not resolved and
   * the button would look like it did nothing.
   */
  public revealPullRequestDetail(payload: { instanceId: string; owner: string; repo: string; index: number }) {
    this._revealView();
    this._postOrQueue({ command: 'openPullRequestDetail', ...payload });
  }

  /** Lets the dashboard reload a PR detail after a review was submitted from the comment panel. */
  public notifyPullRequestReviewSubmitted(payload: { instanceId: string; owner: string; repo: string; index: number }) {
    this._postOrQueue({ command: 'pullRequestReviewSubmitted', ...payload });
  }

  private _postOrQueue(message: HostToWebviewMessage) {
    // When the sidebar has never been shown the webview does not exist yet;
    // queue the message and flush it once the webview mounts and asks for its
    // initial state (see the getInitialState handler). Multiple messages may
    // arrive before that, so this is a queue, not a single slot. The queue is
    // capped: if the sidebar is never resolved at all, an unbounded queue
    // would grow for the whole session — these messages are transient
    // notifications, so the oldest is dropped.
    if (this._view) {
      this._view.webview.postMessage(message);
    } else {
      if (this._pendingMessages.length >= ForgejoToolkitViewProvider.MAX_PENDING_MESSAGES) {
        this._pendingMessages.shift();
        logger.error('Pending webview message queue is full; dropped the oldest message');
      }
      this._pendingMessages.push(message);
    }
  }

  public refresh() {
    // Refresh is also the escape hatch for a repository that changed behind the
    // extension (a merge made elsewhere, a pushed commit): the tree and
    // contents memos have short TTLs but are shared process-wide, so their
    // entries must go before the webview re-reads anything.
    invalidateRepoContentCaches();
    this._sendInstances();
    // A just-published repository must drop the "Publish to Forgejo" button
    // (forgejoToolkit.hasUnpublishedRepo) without waiting for an editor
    // switch; debounced so a refresh burst does not spawn repeated git runs.
    this._scheduleLinkedRepositoryDetect();
    // Also tell the webview to invalidate its instance-level data caches —
    // previously this command only refreshed the instance list itself.
    this._reply('refreshData', {});
  }

  public updateTitle(locale: 'en' | 'zh') {
    this._updateViewTitle(locale);
  }

  private _findInstance(id: unknown): ForgejoInstance | undefined {
    if (typeof id !== 'string') {
      return undefined;
    }
    return this._config.getInstances().find((i) => i.id === id);
  }

  private _buildDiffUri(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    ref: string,
    filepath: string,
    isBase: boolean,
    status?: string,
  ): vscode.Uri {
    return buildForgejoPrDiffUri({ instanceId, owner, repo, index, ref, filepath, isBase, status });
  }

  /**
   * Publishes the sidebar's reported view under the context key the
   * `view/title` refresh items test (`contributes.menus`, gated on
   * `forgejoToolkit.activeView`).
   *
   * A missing report is pushed as `undefined` rather than skipped: the key has
   * to *stop* matching when the webview that named the view is replaced or
   * disposed, or an item would stay on screen for a page the host cannot name.
   */
  private _applyActiveViewContext(): void {
    void vscode.commands.executeCommand('setContext', ACTIVE_VIEW_CONTEXT_KEY, this._reportedActiveView);
  }

  /** Drops the reported view and hides every refresh item until one is reported again. */
  private _forgetActiveView(): void {
    this._reportedActiveView = undefined;
    this._applyActiveViewContext();
  }

  private _updateViewTitle(locale: 'en' | 'zh') {
    if (!this._view) {
      return;
    }
    // The `locale` argument is kept because callers pass the selected locale
    // (the user's `forgejoToolkit.locale` can differ from the display
    // language); the text itself is resolved by l10n so the host has a single
    // source of truth for user-facing strings instead of a hard-coded zh/en
    // pair.
    void locale;
    this._view.title = vscode.l10n.t('Dashboard');
  }

  private _sendInstances() {
    if (this._view?.visible) {
      this._reply('instances', { data: this._config.getInstances().map(toPublicInstance) });
    }
  }

  /**
   * Re-push the tracked worktree records. The Settings list renders exactly what
   * the last `worktreesList` reply carried, so a record that disappeared without
   * a reply (an instance removal forgets its records) would otherwise stay on
   * screen as a row the host can no longer act on.
   */
  private _sendWorktrees() {
    if (this._view?.visible) {
      this._reply('worktreesList', { worktrees: this._worktreeManager.getWorktrees() });
    }
  }

  /**
   * Mandatory host-side confirmation for destructive webview commands. The
   * webview is untrusted: a compromised webview could skip its own confirm
   * dialog, so the host always re-confirms before executing. Webview code
   * must not show its own confirmation for these commands — that would
   * double-prompt the user.
   */
  private async _confirmDestructive(message: string): Promise<boolean> {
    const confirmLabel = vscode.l10n.t('Confirm');
    const choice = await vscode.window.showWarningMessage(message, { modal: true }, confirmLabel);
    return choice === confirmLabel;
  }

  /**
   * Runs one description draft and answers the form's request with what came back.
   *
   * The three arms are reported verbatim and none of them touches the form's body:
   * `ok` carries the text the form fills in (the user still edits and submits it),
   * `cancelled` carries no error — a dismissed consent modal or a dismissed model
   * picker is not a failure, and the run has already shown its own message — and
   * `failed` carries the run's own sentence, which is already user-facing.
   */
  private async _runPrDescription(target: PrDescriptionRequestTarget, requestId: string): Promise<void> {
    const runner = this._prDescriptionRunner;
    if (!runner) {
      logger.error('generatePrDescription lost its run between the dispatch and the call');
      return;
    }
    const outcome = await runner(target);
    if (outcome.kind === 'ok') {
      this._reply('prDescriptionGenerated', { description: outcome.description, _requestId: requestId });
      return;
    }
    if (outcome.kind === 'failed') {
      this._reply('prDescriptionGenerated', { error: outcome.error, _requestId: requestId });
      return;
    }
    // Cancelled: the run has already said what happened (or deliberately said
    // nothing, for a dismissed picker), so this answers the waiting form with the
    // empty arm rather than a second dialog about the same event.
    this._reply('prDescriptionGenerated', { description: '', _requestId: requestId });
  }

  /**
   * Pushes the AI endpoint snapshot the settings page renders.
   *
   * It carries no `_requestId` because it is not an answer to anything: the page
   * keeps the last snapshot it was given, exactly as it keeps the instance list,
   * so a write the host completed is reflected even when the write's own reply was
   * a failure (a partially applied policy, a removal whose confirmation the user
   * accepted). A read that throws is logged and dropped — the page keeps showing
   * the last state it had rather than being handed a fabricated one.
   */
  private async _pushAiProviderSettings(): Promise<void> {
    try {
      const snapshot = await readAiProviderSettings({ secrets: this._context.secrets });
      this._reply('aiProviderSettings', { snapshot });
    } catch (error) {
      logger.error(`Could not read the AI endpoint settings for the webview: ${userFacingErrorMessage(error)}`);
    }
  }

  /**
   * The display name of one configured AI endpoint, for the host's own
   * confirmation prompt. Falls back to the id — an entry the reader could not read
   * still has to be nameable in the question about removing it.
   */
  private _aiProviderName(id: string): string {
    const providers = aiProviderSettingsReading().providers;
    return providers.find((provider) => provider.id === id)?.name ?? id;
  }

  /**
   * The settings page's own surface, read fresh for every request and after every
   * write (`docs/design/settings-page.md` §3.2, §3.5).
   *
   * Each value comes from the reader the behaviour itself uses, which is why the
   * notification switch, the polling interval and the developer mock switch are
   * passed in rather than read here: `ConfigManager` owns those readings (the
   * poller obeys the first two, activation makes its mock decision from the
   * third), and a page that read them a second way could show a state the
   * behaviour disagreed with.
   */
  private _readSettingsSurface(): SettingsSurfaceSnapshot {
    return readSettingsSurface({
      isNotificationPollingEnabled: () => this._config.isNotificationPollingEnabled(),
      getNotificationPollingInterval: () => this._config.getNotificationPollingInterval(),
      isMockApiEnabled: () => this._config.isMockApiEnabled(),
    });
  }

  /**
   * Ask before discarding a leftover PR worktree that is no longer checked out
   * at the PR head. `git worktree remove --force` (plus the throwaway branch
   * delete) drops uncommitted changes and local commits, so those cases need
   * an explicit confirmation; a clean leftover is refreshed silently, since
   * recreating it is the only way to get the updated head and prompting every
   * time would be noise.
   *
   * Only a *known* zero may skip the prompt: `commitsAhead` is `undefined` when
   * the range could not be counted (the PR head sha is fetched later in the open
   * flow, so the leftover's own commits may not be comparable yet), and an
   * unknown count is not evidence that there is nothing to lose.
   */
  private async _confirmDiscardStaleWorktree(info: StalePrWorktreeInfo, index: number): Promise<boolean> {
    if (!info.dirty && info.commitsAhead === 0) {
      return true;
    }
    const holds: string[] = [];
    if (info.dirty) {
      holds.push(vscode.l10n.t('uncommitted changes'));
    }
    if (info.commitsAhead === undefined) {
      holds.push(vscode.l10n.t('local commits that could not be counted'));
    } else if (info.commitsAhead > 0) {
      holds.push(vscode.l10n.t('{0} local commit(s)', info.commitsAhead));
    }
    return this._confirmDestructive(
      vscode.l10n.t(
        'The local worktree for PR #{0} is out of date and holds {1}. Delete it and check out the current PR head? That local work will be lost.',
        index,
        holds.join(', '),
      ),
    );
  }

  /**
   * Ask before replacing the open workspace with a worktree that is about to be
   * created, and report whether to continue. Opening the folder in the current
   * window is what `openWorktree` itself confirms; asking here lets the create
   * paths do it *before* they create anything.
   *
   * The order matters. `openWorktree` confirms inside the call that also opens
   * the folder, so a flow that created the checkout first left it — and the
   * throwaway or issue branch checked out in it — behind with no record when
   * the user declined: nothing in Settings ever listed it and the sweep only
   * reclaims checkouts whose source repository is gone. Confirming first means a
   * decline leaves the cache exactly as it was.
   *
   * The wording and the "Open" label match `openWorktree` (both go through the
   * same localized strings), so the caller passes `confirmed` there and the user
   * still sees one prompt.
   */
  private async _confirmReplaceWorkspace(worktreePath: string, openInNewWindow: boolean): Promise<boolean> {
    if (!requiresWorkspaceReplacement(worktreePath, openInNewWindow)) {
      return true;
    }
    const openLabel = vscode.l10n.t('Open');
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t('This will replace the current workspace with the worktree. Continue?'),
      { modal: true },
      openLabel,
    );
    return choice === openLabel;
  }

  /**
   * Roll back a checkout this flow created when the folder did not end up
   * opening for it: the user decided against the replacement after confirming,
   * or `vscode.openFolder` itself failed. Closes the last hole a cancelled open
   * could fall through — a recordless checkout whose throwaway branch stays
   * checked out, invisible to Settings and to the lazy sweep.
   *
   * **Only for a checkout created by the same call.** It force-deletes the
   * directory (`git worktree remove --force` drops tracked modifications,
   * untracked and ignored files) and deletes a `pr-<n>-<sha7>` branch, so
   * pointing it at a directory that already existed would destroy work this flow
   * never inspected. A failed open of a pre-existing checkout must leave it in
   * place and report the failure instead — see the `'current'` branch of
   * `_doOpenPrWorktree`. The distinction is by call site, not by inspection:
   * the only legitimate caller is the create path, immediately after
   * `createWorktreeFromBranch` succeeded.
   *
   * The branch is only deleted when it is the PR throwaway name
   * (`pr-<n>-<sha7>`); the git helpers' pattern guard leaves any other branch
   * alone, so an unexpected leftover is never destroyed. Best effort: the user
   * already said no, and a failed cleanup must not replace that answer with an
   * error. A leftover that survives is reclaimed by the stale-registration
   * recovery in `fetchPullRequestHead` on the next attempt.
   */
  private async _discardDeclinedPrCheckout(sourceRepoPath: string, worktreePath: string, branch: string) {
    await discardStalePrWorktree(sourceRepoPath, worktreePath, branch).catch((error: unknown) => {
      logger.error(`Could not reclaim the declined PR worktree ${worktreePath}: ${userFacingErrorMessage(error)}`);
    });
  }

  private async _exportInstances(ids?: string[]) {
    if (!this._view) {
      return;
    }
    // Read before the question is asked, and always: what the file will carry
    // decides which warning the user has to see, and an endpoint list is what makes
    // the AI keys and header values a thing the plaintext answer is missing.
    const ai = await this._readAiExportReading();
    const encryptLabel = vscode.l10n.t('Encrypt with password');
    const plainTextLabel = vscode.l10n.t('Plain text');
    const choice = await vscode.window.showWarningMessage(
      ai.ai.providers.length > 0
        ? vscode.l10n.t(
            'Choose how to export instance configuration. Access tokens will be included in plain text unless encrypted, and an unencrypted export contains no AI endpoint key and no header value.',
          )
        : vscode.l10n.t(
            'Choose how to export instance configuration. Access tokens will be included in plain text unless encrypted.',
          ),
      { modal: true },
      encryptLabel,
      plainTextLabel,
    );
    if (choice !== encryptLabel && choice !== plainTextLabel) {
      this._reply('instancesExported', { success: false, cancelled: true });
      return;
    }
    let password: string | undefined;
    if (choice === encryptLabel) {
      password = await this._promptExportPassword();
      if (!password) {
        this._reply('instancesExported', { success: false, cancelled: true });
        return;
      }
    }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file('forgejo-toolkit-instances.json'),
      filters: { JSON: ['json'] },
    });
    if (!uri) {
      this._reply('instancesExported', { success: false, cancelled: true });
      return;
    }
    try {
      // The secrets are attached only on the encrypting branch: a plaintext export
      // writes the `ai` section without them, which is the structural reason no key
      // and no header value can reach an unencrypted file (§10.2).
      let data: object = this._buildExportData(ids, ai);
      if (password) {
        data = this._encryptExportData({ ...(data as object), ai: { ...ai.ai, secrets: ai.secrets } }, password);
      }
      // Atomic write: an export interrupted halfway (a full disk, a crash) must
      // not destroy the export file that is already at that path.
      await writeFileAtomically(uri.fsPath, JSON.stringify(data, null, 2));
      this._reply('instancesExported', { success: true, path: uri.fsPath, aiSecretsIncluded: password !== undefined });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`exportInstances failed: ${err}`);
      this._reply('instancesExported', { success: false, error: err });
    }
  }

  /**
   * The AI configuration an export will write, plus the credentials that only its
   * encrypted wrapper may carry.
   *
   * A settings or secret-store read that throws must not fail the export — the
   * instance list is the primary payload and is unaffected — so a failure reads as
   * "no AI configuration", the same fail-closed direction every other AI reader
   * takes. Nothing is logged with a value in it: only the counts.
   */
  private async _readAiExportReading(): Promise<AiExportReading> {
    try {
      return await readAiConfigForExport(this._context.secrets);
    } catch (error) {
      logger.error(`exportInstances could not read the AI configuration: ${userFacingErrorMessage(error)}`);
      return {
        ai: { providers: [], bindings: [], transport: 'auto' },
        secrets: { keys: {}, headerValues: {} },
      };
    }
  }

  private _buildExportData(ids: string[] | undefined, ai: AiExportReading): object {
    const allInstances = this._config.getInstances();
    const instances = ids ? allInstances.filter((instance) => ids.includes(instance.id)) : allInstances;
    const configuration = vscode.workspace.getConfiguration('forgejoToolkit');
    const settings: ExportSettings = {
      locale: configuration.get<'en' | 'zh'>('locale') ?? undefined,
      debug: configuration.get<boolean>('debug') ?? undefined,
      worktreeOpenMode: this._config.getWorktreeOpenMode(),
      worktreeCacheDirectory: this._config.getWorktreeCacheDirectory() ?? undefined,
    };
    return { version: EXPORT_PAYLOAD_VERSION, instances, settings, ai: ai.ai };
  }

  private async _copyInstancesToClipboard(ids?: string[]) {
    if (!this._view) {
      return;
    }
    // Same reading, same warning and same "secrets only on the encrypting branch"
    // rule as the file export: the clipboard is a file that goes wherever it is
    // pasted.
    const ai = await this._readAiExportReading();
    const encryptLabel = vscode.l10n.t('Encrypt with password');
    const plainTextLabel = vscode.l10n.t('Plain text');
    const choice = await vscode.window.showWarningMessage(
      ai.ai.providers.length > 0
        ? vscode.l10n.t(
            'Choose how to export instance configuration. Access tokens will be included in plain text unless encrypted, and an unencrypted export contains no AI endpoint key and no header value.',
          )
        : vscode.l10n.t(
            'Choose how to export instance configuration. Access tokens will be included in plain text unless encrypted.',
          ),
      { modal: true },
      encryptLabel,
      plainTextLabel,
    );
    if (choice !== encryptLabel && choice !== plainTextLabel) {
      this._reply('instancesExported', { success: false, cancelled: true });
      return;
    }
    let password: string | undefined;
    if (choice === encryptLabel) {
      password = await this._promptExportPassword();
      if (!password) {
        this._reply('instancesExported', { success: false, cancelled: true });
        return;
      }
    }
    try {
      let data: object = this._buildExportData(ids, ai);
      if (password) {
        data = this._encryptExportData({ ...(data as object), ai: { ...ai.ai, secrets: ai.secrets } }, password);
      }
      await vscode.env.clipboard.writeText(JSON.stringify(data, null, 2));
      this._reply('instancesExported', { success: true, aiSecretsIncluded: password !== undefined });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`copyInstancesToClipboard failed: ${err}`);
      this._reply('instancesExported', { success: false, error: err });
    }
  }

  private async _promptExportPassword(): Promise<string | undefined> {
    const password = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Enter export password'),
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) {
      return undefined;
    }
    const confirm = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Confirm export password'),
      password: true,
      ignoreFocusOut: true,
    });
    if (password !== confirm) {
      await vscode.window.showErrorMessage(vscode.l10n.t('Passwords do not match'));
      return undefined;
    }
    return password;
  }

  private _encryptExportData(data: object, password: string): object {
    const iterations = 100_000;
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(16);
    const key = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(data);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      version: EXPORT_PAYLOAD_VERSION,
      encrypted: true,
      iterations,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      data: encrypted.toString('base64'),
    };
  }

  private async _previewImportInstances() {
    if (!this._view) {
      return;
    }
    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { JSON: ['json'] },
    });
    if (!uris || uris.length === 0) {
      // The webview keeps a single in-flight slot for this request; a silent
      // cancel would wedge it forever, so answer explicitly.
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        settings: undefined,
        cancelled: true,
      });
      return;
    }
    try {
      const { instances, settings, dropped, ai } = await readExportDataFromUri(uris[0]);
      // Stash the full entries host-side; the webview only receives a
      // token-less copy and later confirms by id, so token values never
      // cross into the webview process in either direction. The AI half is
      // stashed the same way and for the same reason: an encrypted file's
      // credentials must not reach the webview even to be confirmed.
      this._pendingImportInstances = instances;
      this._pendingImportAi = ai;
      const existingInstances = this._config.getInstances();
      const existingIds = existingInstances.map((instance) => instance.id);
      // Conflict flags (stored-token collisions and in-file duplicates) are
      // computed host-side (parallel to `instances`) — see the message type.
      const tokenConflicts = computeImportTokenConflicts(instances, existingInstances);
      // The AI section is previewed with the ids that are already configured —
      // including entries this build cannot read, which still own their ids.
      const aiPreview = ai === undefined ? undefined : buildAiImportPreview(ai, configuredAiProviderIds());
      const payload: Omit<Extract<HostToWebviewMessage, { command: 'importInstancesPreview' }>, 'command'> = {
        instances: stripInstanceTokens(instances),
        existingIds,
        tokenConflicts,
        settings,
        ...(aiPreview === undefined ? {} : { ai: aiPreview.ai }),
        // The dropped entries never appear in `instances`, so without the count
        // the preview looks complete. Only when something was dropped: an
        // absent field is what a host build without the count sends, and the
        // webview treats that as "nothing to warn about".
        ...(dropped > 0 ? { dropped } : {}),
      };
      this._reply('importInstancesPreview', payload);
    } catch (error) {
      this._pendingImportInstances = undefined;
      this._pendingImportAi = undefined;
      if (error instanceof ImportCancelledError) {
        // The user dismissed the password prompt: answer like the file-picker
        // cancel above so the preview slot frees without an error banner.
        this._reply('importInstancesPreview', {
          instances: [],
          existingIds: [],
          tokenConflicts: [],
          settings: undefined,
          cancelled: true,
        });
        return;
      }
      const err = userFacingErrorMessage(error);
      logger.error(`previewImportInstances failed: ${err}`);
      this._reply('importInstancesPreview', {
        instances: [],
        existingIds: [],
        tokenConflicts: [],
        settings: undefined,
        error: err,
      });
    }
  }

  /**
   * Imports instances, and — in the preview flow — the AI configuration that
   * travelled with them.
   *
   * `aiChoices` is the preview's per-provider collision decision, already reduced
   * to the three answers (`rename`/`replace`/`keep`). It is meaningful only for the
   * preview confirmation, which is the path that actually shows the AI section: the
   * picker flow (`ids` absent) has no preview, so it imports instances and settings
   * only, and the AI section of a file that reaches it is left alone rather than
   * imported without being reviewed. No UI path sends the picker form (the
   * webview's import button goes through `previewImportInstances`), so this is the
   * disposition for a message a compromised webview could send.
   */
  private async _importInstances(
    instancesToImport?: ForgejoInstance[],
    settings?: ExportSettings,
    aiChoices?: AiImportConflictChoices,
  ) {
    if (!this._view) {
      return;
    }
    let instances: ForgejoInstance[];
    if (instancesToImport) {
      instances = instancesToImport;
    } else {
      const uris = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { JSON: ['json'] },
      });
      if (!uris || uris.length === 0) {
        this._reply('instancesImported', { success: false, cancelled: true });
        return;
      }
      try {
        const data = await readExportDataFromUri(uris[0]);
        instances = data.instances;
        if (data.settings) {
          settings = data.settings;
        }
      } catch (error) {
        if (error instanceof ImportCancelledError) {
          // Dismissing the password prompt is a cancel, not a failure: match
          // the file-picker cancel reply so no error status is shown.
          this._reply('instancesImported', { success: false, cancelled: true });
          return;
        }
        const err = userFacingErrorMessage(error);
        logger.error(`importInstances failed: ${err}`);
        this._reply('instancesImported', { success: false, error: err });
        return;
      }
    }
    try {
      for (const instance of instances) {
        try {
          await this._config.addInstance(instance);
        } catch (error) {
          // Same contract as the onboarding guide: the failure reply names the
          // instance, because "the import failed" alone gives the user nothing
          // to act on.
          throw new Error(
            vscode.l10n.t(
              'Importing instance {0} failed: {1}',
              instance.name || instance.url,
              userFacingErrorMessage(error),
            ),
          );
        }
      }
      await this._applyImportSettings(settings);
      let aiConfigApplied = false;
      if (instancesToImport !== undefined) {
        aiConfigApplied = await this._applyImportedAiConfig(aiChoices);
      }
      this._sendInstances();
      this._detectAndSendLinkedRepository();
      this._reply('instancesImported', { success: true, count: instances.length });
      if (aiConfigApplied) {
        // The settings page renders the AI half from the last snapshot the host
        // pushed and reads it only on mount, so the endpoints and bindings this
        // import just wrote would stay invisible until a reload without this —
        // measured: the settings file held the imported endpoint while the page
        // still showed the pre-import list, policy mirror and binding label.
        // After the reply, so the page reports the import's own outcome first.
        await this._pushAiProviderSettings();
      }
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`importInstances failed: ${err}`);
      this._reply('instancesImported', { success: false, error: err });
    }
  }

  /**
   * Writes the AI configuration the preview confirmed, from the host-side stash.
   *
   * The stash is cleared first, whatever the outcome: a config that has been
   * applied once — or whose write failed — must not be applied again by a second
   * confirmation message.
   *
   * A failure here is logged and reported, never thrown at the instance import that
   * already succeeded: the endpoints are a second half of the file, and losing them
   * must not turn a completed instance import into a failure. Nothing is logged with
   * a value in it — only the failure and the counts.
   *
   * The answer says whether the file carried an AI section this call **reached** —
   * not whether every write in it succeeded. A file with an AI section can change
   * the provider list and the bindings, each of which the settings page renders from
   * its own snapshot, so the caller has to re-push that snapshot for either of them.
   * A failure is reported to the user by itself (below) and leaves the page on the
   * host's own re-reading of what actually landed, which is the honest state either
   * way.
   */
  private async _applyImportedAiConfig(choices: AiImportConflictChoices | undefined): Promise<boolean> {
    const parsed: ParsedAiSection | undefined = this._pendingImportAi;
    this._pendingImportAi = undefined;
    if (parsed === undefined || this._view === undefined) {
      return false;
    }
    const plan: AiImportPlan = {
      config: parsed.config,
      secretsIncluded: parsed.secretsIncluded,
      secrets: parsed.secrets,
      providers: parsedAiProviderConfigs(parsed),
    };
    try {
      const { applied, skippedBindings } = await applyAiImport(plan, choices ?? {}, this._context.secrets);
      logger.info(
        `AI endpoints: the import wrote ${applied} endpoint(s)` +
          (skippedBindings.length > 0 ? ` and dropped ${skippedBindings.length} binding(s)` : ''),
      );
      if (skippedBindings.length > 0) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'Imported {0} AI endpoint(s). {1} feature binding(s) named an endpoint this import did not write, so they were not applied.',
            applied,
            skippedBindings.length,
          ),
        );
      }
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`the imported AI configuration could not be applied: ${err}`);
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Could not apply the AI configuration from the import file: {0}', err),
      );
    }
    // Answered for the section that reached the writer, failures included: the
    // caller re-pushes the page's own reading of the state, not this function's
    // report of it.
    return true;
  }

  /**
   * Persist a custom worktree cache directory after validating that it exists
   * (creating it when needed) and is writable. Returns false and surfaces an
   * error when the directory cannot be used; an empty value resets to the
   * default directory and is always accepted.
   */
  private async _setWorktreeCacheDirectory(directory: string): Promise<boolean> {
    const trimmed = directory.trim();
    if (trimmed) {
      try {
        await validateCacheDirectory(trimmed);
      } catch (error) {
        const err = userFacingErrorMessage(error);
        void vscode.window.showErrorMessage(
          vscode.l10n.t('Cannot use "{0}" as the worktree cache directory: {1}', trimmed, err),
        );
        return false;
      }
    }
    await this._config.setWorktreeCacheDirectory(trimmed);
    return true;
  }

  private async _applyImportSettings(settings: ExportSettings | undefined) {
    if (!settings) {
      return;
    }
    const configuration = vscode.workspace.getConfiguration('forgejoToolkit');
    if (settings.locale === 'en' || settings.locale === 'zh') {
      await configuration.update('locale', settings.locale, true);
      this._reply('setLocale', { locale: settings.locale });
      this._updateViewTitle(settings.locale);
    }
    if (typeof settings.debug === 'boolean') {
      await configuration.update('debug', settings.debug, true);
      this._reply('setDebug', { debug: settings.debug });
    }
    if (
      settings.worktreeOpenMode === 'ask' ||
      settings.worktreeOpenMode === 'currentWindow' ||
      settings.worktreeOpenMode === 'newWindow'
    ) {
      await this._config.setWorktreeOpenMode(settings.worktreeOpenMode);
      this._reply('worktreeOpenMode', { mode: settings.worktreeOpenMode });
    }
    if (typeof settings.worktreeCacheDirectory === 'string') {
      if (await this._setWorktreeCacheDirectory(settings.worktreeCacheDirectory)) {
        const directory = this._config.getWorktreeCacheDirectory() ?? '';
        const defaultDirectory = this._config.getDefaultWorktreeCacheDirectory();
        this._reply('worktreeCacheDirectory', { directory, defaultDirectory });
      }
    }
  }

  private _linkedRepoDetectTimer: ReturnType<typeof setTimeout> | undefined;
  /** Cold-start detection timer; cleared on dispose so a disposed host never scans git. */
  private _initialDetectTimer: ReturnType<typeof setTimeout> | undefined;

  // Debounced: rapid tab switches must not spawn a git subprocess burst.
  private _scheduleLinkedRepositoryDetect(): void {
    clearTimeout(this._linkedRepoDetectTimer);
    this._linkedRepoDetectTimer = setTimeout(() => {
      void this._detectAndSendLinkedRepository();
    }, 300);
  }

  private async _detectAndSendLinkedRepository() {
    try {
      const { linked, all, unpublished } = await detectLinkedRepositories(this._config.getInstances());
      // Gate the editor context menu (Copy Permalink) on whether the workspace
      // is linked to a Forgejo repository. This must run even when the view is
      // hidden, otherwise the key stays false until the sidebar is opened.
      void vscode.commands.executeCommand('setContext', 'forgejoToolkit.hasLinkedRepo', Boolean(linked));
      // The SCM "Publish to Forgejo" button only makes sense while at least one
      // workspace repository has no Forgejo remote yet; once everything is
      // published, pushing belongs to the built-in sync action.
      void vscode.commands.executeCommand('setContext', 'forgejoToolkit.hasUnpublishedRepo', unpublished.length > 0);
      if (!this._view?.visible) {
        return;
      }
      this._reply('linkedRepository', { linked, all });
    } catch (error) {
      // Timer- and event-driven callers have no error surface; a rejection
      // here would otherwise surface as an unhandled rejection.
      logger.error(`Linked repository detection failed: ${userFacingErrorMessage(error)}`);
    }
  }

  private _reply<T extends HostToWebviewMessage['command']>(
    command: T,
    data: Omit<Extract<HostToWebviewMessage, { command: T }>, 'command'>,
  ) {
    // Mark the request as answered so the dispatch fallback does not emit a
    // duplicate requestError reply.
    const requestId = (data as { _requestId?: unknown })._requestId;
    if (typeof requestId === 'string') {
      this._unansweredForCurrentSurface().delete(requestId);
    }
    const message = { command, ...data } as HostToWebviewMessage;
    // The surface that asked, when a handler is running; the sidebar otherwise.
    const sink = this._replySink.getStore();
    if (sink) {
      sink(message);
      return;
    }
    this._view?.webview.postMessage(message);
  }

  /**
   * `coveredIds` is the poller's own report of the ids it examined, passed
   * through unchanged: it is not derivable from `notifications`, because a poll
   * can examine a row and find it read (it is then absent from a page of the
   * unread+pinned set), and "mark all as read" covers ids the refresh poll no
   * longer returns. See `NotificationPoller._coverageFor`.
   */
  public pushNotifications(instanceId: string, notifications: unknown[], coveredIds: number[]): void {
    this._reply('polledNotifications', { instanceId, notifications, coveredIds });
  }

  public pushNotificationError(instanceId: string, error: string): void {
    this._reply('polledNotifications', { instanceId, error });
  }

  /**
   * Routed like `openSettings` rather than through `_reply`: the poller toasts a
   * new notification before the sidebar has ever been resolved, and `_reply`
   * silently drops the message then (`this._view` is undefined), so the toast's
   * "Open" button did nothing at all until the user happened to open the view.
   */
  public openNotifications(): void {
    this._revealView();
    this._postOrQueue({ command: 'openNotifications' });
  }

  /**
   * Worktree directory for a PR/issue: the record of an existing worktree wins
   * so a worktree created before the instance discriminator existed keeps its
   * directory (and cannot be orphaned by the new naming below). Otherwise the
   * name carries an instance-derived suffix, because `worktrees/` is shared by
   * every instance and the same `owner/repo` slug on two instances must not
   * resolve to one directory: the second open would reuse - and
   * `discardStalePrWorktree` could delete - the other instance's checkout.
   */
  private _resolveWorktreePath(worktreesDir: string, defaultName: string, worktreeId: string): string {
    const recorded = this._worktreeManager.getWorktree(worktreeId);
    if (recorded?.worktreePath && isPathInsideFolder(worktreesDir, recorded.worktreePath)) {
      return recorded.worktreePath;
    }
    return path.join(worktreesDir, defaultName);
  }

  private async _handleOpenPrWorktree(message: { instanceId: string; owner: string; repo: string; index: number }) {
    // A rapid second invocation for the same PR reuses the in-flight run
    // instead of fetching the same branch or adding the same path twice.
    const key = `${message.instanceId}:${message.owner}/${message.repo}#${message.index}`;
    await this._worktreeInFlight.run(key, () => this._doOpenPrWorktree(message));
  }

  /**
   * Self-healing for a half-written cache clone. A bare-clone directory that
   * exists but carries no usable `remote.origin.url` (a `git clone` killed
   * mid-transfer, or a leftover of a failed cross-window cleanup) used to
   * poison the cache path forever: existence alone satisfied the reuse check,
   * so every later open skipped the clone and failed at remote resolution with
   * "No git remote in the local repository points at …". The existence check is
   * therefore upgraded to a completeness check (`hasUsableOriginRemote`, the
   * same probe the clone's own failure cleanup applies).
   *
   * Returns whether a usable cache clone remains at `cacheRepoPath`:
   *
   * - Complete clone: left alone (true).
   * - Incomplete, with a `<basename>.clone-owner.*` marker beside it: another
   *   extension host is cloning into it right now (`cloneRepository` writes
   *   that marker before it starts). It is not this call's to delete, so the
   *   previous "exists means reuse" behavior is kept (true); this attempt then
   *   fails at remote resolution exactly as it does today, which is transient —
   *   the in-flight clone replaces the remnant.
   * - Incomplete, no marker: nobody owns the remnant, so it is deleted and the
   *   caller treats the path as absent (false), re-cloning from scratch.
   *
   * A marker appearing between the scan and the `rm` is the race this cannot
   * close; it is accepted because `cloneRepository`'s own completeness-gated
   * cleanup bounds the damage of a doubly-removed partial clone, and deleting
   * nothing would resurrect the permanent-poison failure this fixes.
   */
  private async _reclaimIncompleteCacheClone(cacheRepoPath: string): Promise<boolean> {
    if (await hasUsableOriginRemote(cacheRepoPath)) {
      return true;
    }
    if (await this._hasCloneInFlightMarker(cacheRepoPath)) {
      return true;
    }
    try {
      await fs.promises.rm(cacheRepoPath, { recursive: true, force: true });
      logger.info(`Deleted the incomplete cache clone left at ${cacheRepoPath}; the next step re-clones it`);
      return false;
    } catch (error) {
      // A delete that fails (a file still held open on Windows) must not break
      // the flow: fall back to the old behavior and let remote resolution
      // report the remnant as before.
      logger.error(`Could not remove the incomplete cache clone at ${cacheRepoPath}: ${userFacingErrorMessage(error)}`);
      return true;
    }
  }

  /**
   * Whether a `cloneRepository` ownership marker (`<target>.clone-owner.<token>`)
   * sits beside `cacheRepoPath`, meaning another extension host may still be
   * cloning into it. The marker naming mirrors cloneRepository and must stay in
   * sync with it. Failing closed: when the directory cannot even be listed, an
   * in-flight clone cannot be ruled out, so the remnant is reported as owned.
   */
  private async _hasCloneInFlightMarker(cacheRepoPath: string): Promise<boolean> {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.dirname(cacheRepoPath));
    } catch {
      return true;
    }
    const markerPrefix = `${path.basename(cacheRepoPath)}.clone-owner.`;
    return names.some((name) => name.startsWith(markerPrefix));
  }

  /**
   * Resolve the local checkout a worktree can be added to: the current
   * workspace, a previously used local clone, or the shared bare cache
   * (offering to clone or pick a folder). Never replies to the webview; the
   * caller maps the outcome to its own reply message. A clone failure is
   * thrown so the caller's catch reports it like any other git error.
   */
  private async _resolveWorktreeSourceRepo(
    instance: ForgejoInstance,
    owner: string,
    repo: string,
  ): Promise<
    | { kind: 'resolved'; sourceRepoPath: string; cacheDir: string }
    | { kind: 'cancelled' }
    | { kind: 'error'; message: string }
  > {
    // Trailing slashes and the userinfo are stripped by `worktreeCloneUrl`
    // (see its doc comment): this URL reaches `git clone --bare`'s argv and the
    // cache clone's `remote.origin.url`, so it may carry no credential.
    const cloneUrl = worktreeCloneUrl(instance, owner, repo);
    const cacheDir = this._worktreeManager.getCacheDirectory();

    let sourceRepoPath = await isCurrentWorkspaceBaseRepo(instance.url, owner, repo);
    if (!sourceRepoPath) {
      sourceRepoPath = await findLocalRepo(instance.url, owner, repo);
    }

    if (!sourceRepoPath) {
      // The shared bare clone is keyed by repository *and* instance: two
      // configured instances commonly host the same `owner/repo` slug, and a
      // single-instance path would make the second instance silently reuse the
      // first one's clone (its remotes point at the other host, so the
      // subsequent "which remote belongs to this repo" lookup fails).
      const cacheRepoPath = path.join(cacheDir, 'repos', `${owner}-${repo}-${instanceCacheSuffix(instance)}.git`);
      let cacheRepoExisted = await fs.promises
        .access(cacheRepoPath)
        .then(() => true)
        .catch(() => false);
      if (cacheRepoExisted) {
        cacheRepoExisted = await this._reclaimIncompleteCacheClone(cacheRepoPath);
      }

      const choice = await vscode.window.showQuickPick(
        [
          {
            label: cacheRepoExisted
              ? vscode.l10n.t('Open cached bare repository')
              : vscode.l10n.t('Clone to cache directory'),
            value: 'clone' as const,
          },
          { label: vscode.l10n.t('Select an existing local repository'), value: 'select' as const },
          { label: vscode.l10n.t('Cancel'), value: 'cancel' as const },
        ],
        {
          placeHolder: vscode.l10n.t('No local repository found for {owner}/{repo}. What would you like to do?', {
            owner,
            repo,
          }),
          ignoreFocusOut: true,
        },
      );
      if (!choice || choice.value === 'cancel') {
        return { kind: 'cancelled' };
      }

      if (choice.value === 'clone') {
        sourceRepoPath = cacheRepoPath;
        if (!cacheRepoExisted) {
          // Dedupe on the target path: a concurrent open of another PR from
          // the same repository reuses the in-flight clone instead of running
          // `git clone --bare` into the same directory (which would fail).
          await this._bareCloneInFlight.run(`clone:${cacheRepoPath}`, async () => {
            // Re-check inside the task: when this run is not the one that
            // started the clone (or the other open finished while this one
            // was still at the picker), the cache repository is already there.
            const nowExists = await fs.promises.access(cacheRepoPath).then(
              () => true,
              () => false,
            );
            if (nowExists) {
              return;
            }
            await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Cloning {0}/{1}…', owner, repo),
              },
              () => cloneRepository(cloneUrl, cacheRepoPath, instance.token),
            );
          });
        }
        await this._worktreeManager.touchCachedRepo(cacheRepoPath);
        // Lazy LRU sweep of the bare clone cache (no timer): aged-out and
        // over-cap repositories are removed while a worktree is created. The
        // clone this call is about to work in is passed as protected because the
        // sweep only knows about clones a *recorded* worktree references, and
        // this one has no record yet — it is whatever the sweep decides about an
        // unreferenced clone, whether that is an age eviction (when the touch
        // has not been observed) or a count-cap victim.
        void this._worktreeManager
          .cleanupCachedRepos(Date.now(), [cacheRepoPath])
          .then((removed) => {
            if (removed.length > 0) {
              logger.info(`Cleaned up ${removed.length} unused cached repositories: ${removed.join(', ')}`);
            }
          })
          .catch((error: unknown) => {
            logger.debug(`Cached repository cleanup failed: ${userFacingErrorMessage(error)}`);
          });
      } else {
        const selected = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: vscode.l10n.t('Select repository'),
        });
        if (!selected || selected.length === 0) {
          return { kind: 'cancelled' };
        }
        sourceRepoPath = selected[0].fsPath;
        if (!(await isGitRepository(sourceRepoPath))) {
          return { kind: 'error', message: vscode.l10n.t('Selected folder is not a git repository') };
        }
        const remotes = await listRemotes(sourceRepoPath);
        const normalizedInstanceUrl = instance.url.replace(/\/$/, '');
        const expectedUrls = [
          `${normalizedInstanceUrl}/${owner}/${repo}.git`,
          `${normalizedInstanceUrl}/${owner}/${repo}`,
        ];
        // Transport-agnostic comparison: an ssh/scp remote and the https spelling
        // of the same repository name the same repository, credentials are
        // ignored, and a portless transport (ssh/scp/git) matches an instance URL
        // with or without a web port. The shared normalizeGitUrl comparison
        // matched none of those, so the user's own checkout was rejected as "not
        // the PR base repository" whenever the remote carried a token, used an scp
        // login other than `git`, or the instance URL carried a port.
        const matches = remotes.some((remote) => expectedUrls.some((url) => sameRepositoryUrl(remote.url, url)));
        if (!matches) {
          return { kind: 'error', message: vscode.l10n.t('Selected repository does not match the PR base repository') };
        }
      }
    }
    return { kind: 'resolved', sourceRepoPath, cacheDir };
  }

  private async _handleStartWorkOnIssue(message: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    title?: string;
  }) {
    // The guard key is built from the raw fields on purpose: `_doStartWorkOnIssue`
    // echoes them back for an invalid target, and reusing the same parts keeps
    // the in-flight entry and the reply's loading key in sync.
    const key = `start-work:${message.instanceId}:${message.owner}/${message.repo}#${message.index}`;
    await this._worktreeInFlight.run(key, () => this._doStartWorkOnIssue(message));
  }

  private async _doStartWorkOnIssue(message: {
    instanceId: unknown;
    owner: unknown;
    repo: unknown;
    index: unknown;
    title?: string;
  }) {
    const target = parseWorktreeTarget(message);
    if (!target) {
      logger.error(`startWorkOnIssue ignored: invalid repository identity in the webview message`);
      // The webview sets its start-work spinner before posting and only clears
      // it on a `startWorkResult`; dropping the invalid target silently would
      // leave that spinner running forever. The identity fields are echoed
      // exactly as they arrived: the webview builds its loading key by string
      // interpolation of what it posted, so substituting a placeholder here
      // (''/0) would build a *different* key and the error would never reach the
      // spinner it is meant to clear. The request's own `command` is stripped
      // first: `_reply` prepends the reply's command and spreading the message
      // last would put the request's back in its place.
      const { command: _command, ...echoedIdentity } = message as Record<string, unknown>;
      this._reply('startWorkResult', {
        ...echoedIdentity,
        error: vscode.l10n.t('The request could not be completed'),
      } as Parameters<typeof this._reply<'startWorkResult'>>[1]);
      return;
    }
    const { instanceId, owner, repo, index } = target;
    const reply = (data: { cancelled?: boolean; error?: string; worktree?: unknown }) =>
      this._reply('startWorkResult', { instanceId, owner, repo, index, ...data });

    const instance = this._findInstance(instanceId);
    if (!instance) {
      reply({ error: vscode.l10n.t('Instance not found') });
      return;
    }

    let openMode = this._config.getWorktreeOpenMode();
    if (openMode === 'ask') {
      const choice = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('New window'), value: 'newWindow' as const },
          { label: vscode.l10n.t('Current window'), value: 'currentWindow' as const },
        ],
        {
          placeHolder: vscode.l10n.t('How would you like to open the issue worktree?'),
          ignoreFocusOut: true,
        },
      );
      if (!choice) {
        reply({ cancelled: true });
        return;
      }
      openMode = choice.value;
    }
    const openInNewWindow = openMode === 'newWindow';

    try {
      const resolved = await this._resolveWorktreeSourceRepo(instance, owner, repo);
      if (resolved.kind === 'cancelled') {
        reply({ cancelled: true });
        return;
      }
      if (resolved.kind === 'error') {
        reply({ error: resolved.message });
        return;
      }
      const { sourceRepoPath, cacheDir } = resolved;

      const slug = sanitizeForPath(message.title ?? '');
      const slugSuffix = slug ? `-${slug}` : '';
      const branch = `issue-${index}${slugSuffix}`;
      const worktreesDir = path.join(cacheDir, 'worktrees');
      const worktreeId = `${instanceId}:${owner}/${repo}#issue-${index}`;
      const worktreePath = this._resolveWorktreePath(
        worktreesDir,
        `${owner}-${repo}-${instanceCacheSuffix(instance)}-issue-${index}${slugSuffix}`,
        worktreeId,
      );
      assertInsideWorktreeCache(worktreesDir, worktreePath);

      // A leftover directory from an earlier start-work run is reopened as
      // is; the branch inside is already the issue branch. A directory with no
      // `.git` entry is *not* provably this extension's leftover — the worktree
      // cache directory is user-configurable and may point at a folder that
      // already holds unrelated content (see KNOWN_ISSUES) — so it is never
      // recursively deleted on sight. That is the project's invariant
      // elsewhere: the lazy sweep refuses a directory without the
      // `git worktree add` marker (see isAbandonedWorktree) and the PR paths
      // ask first (see _confirmDiscardStaleWorktree). This path asks too, and
      // names the path it is about; a decline refuses the start and says how to
      // unblock it instead of deleting anything. A confirmed delete goes through
      // the worktree-aware removal, so it cannot leave a registration behind
      // (see the removal below).
      let existsOnDisk = await fs.promises.access(worktreePath).then(
        () => true,
        () => false,
      );
      if (existsOnDisk) {
        const looksLikeWorktree = await fs.promises.access(path.join(worktreePath, '.git')).then(
          () => true,
          () => false,
        );
        if (!looksLikeWorktree) {
          const discard = await this._confirmDestructive(
            vscode.l10n.t(
              'The worktree folder {0} is not a git worktree created by this extension. Delete it and create the worktree again? Everything in that folder will be lost.',
              worktreePath,
            ),
          );
          if (!discard) {
            reply({
              error: vscode.l10n.t(
                'The worktree folder {0} is not a git worktree created by this extension and was left untouched. Delete it yourself or pick another worktree cache directory, then try again.',
                worktreePath,
              ),
            });
            return;
          }
          logger.error(`startWorkOnIssue: removing invalid leftover directory ${worktreePath}`);
          // Worktree-aware, not a bare `fs.rm`: a directory that is not a
          // checkout of *this* repository can still be registered as one
          // (a cache-directory change, or an earlier attempt whose marker was
          // removed by hand). A bare delete would leave that registration behind
          // and the next attempt would then fail on git's "already used by
          // worktree at <path>" for a path that no longer exists — the same
          // wedge the PR paths avoid by deleting through
          // removeWorktreeAndPrune, which also prunes the registration.
          try {
            await removeWorktreeAndPrune(sourceRepoPath, worktreePath);
          } catch (error) {
            // The confirmed state is "gone", so the create below must still be
            // attempted. A registration that survived is reclaimed by the retry
            // in createWorktreeWithNewBranch when its directory is really gone.
            logger.error(`startWorkOnIssue could not reclaim ${worktreePath}: ${userFacingErrorMessage(error)}`);
          }
          existsOnDisk = false;
        }
      }
      let defaultBranch = 'main';
      // The remote the checkout is fetched through, resolved only on the create
      // path; it is kept so the fetch can run *after* the confirmation below.
      let remoteName: string | undefined;
      if (!existsOnDisk) {
        const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
        const detail = await client.getRepoDetail(owner, repo);
        defaultBranch = detail.repository.default_branch ?? 'main';
        // Fetch through the remote that actually points at this repo, not a
        // hardcoded 'origin' (with several remotes it may point elsewhere).
        remoteName = await resolveRemoteForRepo(sourceRepoPath, instance.url, owner, repo);
        if (!remoteName) {
          reply({ error: vscode.l10n.t('No git remote in the local repository points at {0}/{1}', owner, repo) });
          return;
        }
      } else {
        // Reopening a leftover directory needs no git work, but the recorded
        // base branch should still be right. A recorded worktree already
        // carries it (no API call, so reopening stays possible offline);
        // otherwise resolve the default branch like the create path, falling
        // back to 'main' when the server cannot be reached — the branch is
        // display-only, so a wrong guess must not block the open.
        const recorded = this._worktreeManager.getWorktree(worktreeId);
        if (recorded) {
          defaultBranch = recorded.baseBranch;
        } else {
          try {
            const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
            const detail = await client.getRepoDetail(owner, repo);
            defaultBranch = detail.repository.default_branch ?? 'main';
          } catch (error) {
            logger.error(
              `startWorkOnIssue: could not resolve the default branch of ${owner}/${repo}: ${userFacingErrorMessage(error)}`,
            );
          }
        }
      }

      // Ask before creating anything. This path used to create the checkout and
      // its issue branch first and only then ask, so a decline left a
      // recordless checkout with `issue-<n>` checked out; once that directory
      // was gone (a cache-directory change, disk cleanup) its git worktree
      // registration survived and every later attempt failed on git's
      // "already checked out at <old path>", recoverable only by a manual
      // `git worktree prune`. The PR paths were reordered to confirm first for
      // the same reason; this makes the two symmetric. `createdCheckout` is the
      // record of whether the directory below is this call's work, so only the
      // rollback paths that may delete touch it.
      const createdCheckout = !existsOnDisk;
      if (!(await this._confirmReplaceWorkspace(worktreePath, openInNewWindow))) {
        reply({ cancelled: true });
        return;
      }

      if (createdCheckout) {
        // FETCH_HEAD works as the start point in regular checkouts and bare
        // cache clones alike (see fetchBranch).
        await fetchBranch(sourceRepoPath, remoteName!, defaultBranch, instance.token);
        await createWorktreeWithNewBranch(sourceRepoPath, worktreePath, branch, 'FETCH_HEAD');
      }

      // Record the worktree so the Settings UI can delete it and the bare
      // cache clone stays protected from the LRU sweep. Same persistence
      // timing as openPrWorktree: in current-window mode the record has to
      // be written before openFolder reloads the window.
      const worktree: WorktreeInfo = {
        id: worktreeId,
        kind: 'issue',
        instanceId,
        owner,
        repo,
        prIndex: index,
        prTitle: message.title ?? `Issue #${index}`,
        headBranch: branch,
        headSha: '',
        baseBranch: defaultBranch,
        sourceRepoPath,
        worktreePath,
        createdAt: Date.now(),
      };
      const opened = await openWorktree(
        worktreePath,
        openInNewWindow,
        () => this._worktreeManager.addWorktree(worktree),
        { confirmed: true },
      );
      if (!opened) {
        // The user accepted the replacement and then the folder did not open.
        // A fresh checkout is rolled back — leaving it would be a recordless
        // checkout with `issue-<n>` checked out, the state the confirm-first
        // order above exists to avoid. The user's own issue branch is not work
        // they had before this call, but a failed *open* is still no reason to
        // delete it (git may fail to remove a directory in use), so the branch
        // is left in place and the checkout is removed best-effort. A reopened
        // leftover is never touched: it predates this call and may hold work.
        if (createdCheckout) {
          await removeWorktreeAndPrune(sourceRepoPath, worktreePath).catch((error: unknown) => {
            logger.error(
              `startWorkOnIssue could not reclaim the checkout ${worktreePath} after a failed open: ${userFacingErrorMessage(error)}`,
            );
          });
        }
        reply({ cancelled: true });
        return;
      }
      if (openInNewWindow) {
        await this._worktreeManager.addWorktree(worktree);
      }
      // The webview merges this into its worktree list, so a worktree created by
      // "Start work" appears in Settings without a separate round trip.
      reply({ worktree });
      vscode.window.showInformationMessage(
        vscode.l10n.t('Started work on issue #{0}: created branch {1}', index, branch),
      );
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`startWorkOnIssue failed for ${owner}/${repo}#${index}: ${err}`);
      reply({ error: err });
    }
  }

  private async _doOpenPrWorktree(message: { instanceId: string; owner: string; repo: string; index: number }) {
    const target = parseWorktreeTarget(message);
    if (!target) {
      logger.error(`openPrWorktree ignored: invalid repository identity in the webview message`);
      // _doStartWorkOnIssue answers its invalid-target path the same way: the
      // PR view sets its spinner before posting and only a worktree reply
      // clears it, so dropping the request silently would leave it spinning.
      this._reply('worktreeError', {
        error: vscode.l10n.t('The request could not be completed'),
        operation: 'open',
        instanceId: typeof message.instanceId === 'string' ? message.instanceId : undefined,
        owner: typeof message.owner === 'string' ? message.owner : undefined,
        repo: typeof message.repo === 'string' ? message.repo : undefined,
        index: typeof message.index === 'number' ? message.index : undefined,
      });
      return;
    }
    const { instanceId, owner, repo, index } = target;
    const instance = this._findInstance(instanceId);
    if (!instance) {
      this._reply('worktreeError', {
        error: vscode.l10n.t('Instance not found'),
        operation: 'open',
        instanceId,
        owner,
        repo,
        index,
      });
      return;
    }

    let openMode = this._config.getWorktreeOpenMode();
    if (openMode === 'ask') {
      const choice = await vscode.window.showQuickPick(
        [
          { label: vscode.l10n.t('New window'), value: 'newWindow' as const },
          { label: vscode.l10n.t('Current window'), value: 'currentWindow' as const },
        ],
        {
          placeHolder: vscode.l10n.t('How would you like to open the PR worktree?'),
          ignoreFocusOut: true,
        },
      );
      if (!choice) {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      openMode = choice.value;
    }
    const openInNewWindow = openMode === 'newWindow';

    const existing = this._worktreeManager.findWorktree(instanceId, owner, repo, index);
    // PR detail fetched for the head-sha revalidation of a recorded worktree;
    // the create path below reuses it instead of issuing a second API call.
    let prefetchedPr: Awaited<ReturnType<ForgejoClient['getPullRequestDetail']>> | undefined;
    if (existing) {
      const existsOnDisk = await fs.promises.access(existing.worktreePath).then(
        () => true,
        () => false,
      );
      if (existsOnDisk) {
        // A recorded worktree is only reopened as-is when the PR head still
        // matches the recorded sha; after a force-push the outdated directory
        // must not be opened silently. findWorktree only returns PR records,
        // so issue worktrees (which have no head sha) never reach this check.
        // When the current head cannot be determined, the open fails the same
        // way the no-record create path does instead of guessing.
        try {
          const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
          prefetchedPr = await client.getPullRequestDetail(owner, repo, index);
        } catch (error) {
          const err = userFacingErrorMessage(error);
          logger.error(`openPrWorktree head check failed for ${owner}/${repo}#${index}: ${err}`);
          this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
          return;
        }
        const currentHeadSha = prefetchedPr.head?.sha;
        if (!currentHeadSha) {
          this._reply('worktreeError', {
            error: vscode.l10n.t('Could not determine PR head branch or sha'),
            operation: 'open',
            instanceId,
            owner,
            repo,
            index,
          });
          return;
        }
        if (currentHeadSha === existing.headSha) {
          try {
            const opened = await openWorktree(existing.worktreePath, openInNewWindow);
            if (!opened) {
              this._reply('worktreeCancelled', { instanceId, owner, repo, index });
              return;
            }
            this._reply('worktreeOpened', { worktree: existing, existed: true });
          } catch (error) {
            const err = userFacingErrorMessage(error);
            this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
          }
          return;
        }
        // Stale record: discard the outdated directory and its throwaway
        // branch through the same stale semantics as a leftover directory,
        // then fall through to the create path with the record kept;
        // addWorktree overwrites it with the new head. The recorded path is
        // revalidated explicitly because a renamed PR title changes the path
        // the create path computes, which would otherwise orphan this one.
        try {
          const inspection = await inspectPrWorktree(existing.worktreePath, currentHeadSha);
          if (inspection.state === 'stale') {
            if (!(await this._confirmDiscardStaleWorktree(inspection.info, index))) {
              this._reply('worktreeCancelled', { instanceId, owner, repo, index });
              return;
            }
            await discardStalePrWorktree(existing.sourceRepoPath, existing.worktreePath, inspection.info.branch);
          }
        } catch (error) {
          const err = userFacingErrorMessage(error);
          this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
          return;
        }
      } else {
        // The recorded worktree directory is gone from disk; drop the stale
        // record and fall through to recreate it.
        await this._worktreeManager.forgetWorktree(existing.id);
      }
    }

    try {
      const client = new ForgejoClient(instance.url, instance.token, logger, instance.syncApiUrlsToInstanceUrl);
      const pr = prefetchedPr ?? (await client.getPullRequestDetail(owner, repo, index));
      const headBranch = pr.head?.ref;
      const headSha = pr.head?.sha;
      const baseBranch = pr.base?.ref ?? 'main';
      const prTitle = pr.title ?? `PR #${index}`;
      if (!headBranch || !headSha) {
        this._reply('worktreeError', {
          error: vscode.l10n.t('Could not determine PR head branch or sha'),
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }

      const resolved = await this._resolveWorktreeSourceRepo(instance, owner, repo);
      if (resolved.kind === 'cancelled') {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      if (resolved.kind === 'error') {
        this._reply('worktreeError', {
          error: resolved.message,
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }
      const { sourceRepoPath, cacheDir } = resolved;

      const sanitizedTitle = sanitizeForPath(prTitle);
      const titleSuffix = sanitizedTitle ? `-${sanitizedTitle}` : '';
      const worktreesDir = path.join(cacheDir, 'worktrees');
      const worktreePath = this._resolveWorktreePath(
        worktreesDir,
        `${owner}-${repo}-${instanceCacheSuffix(instance)}-pr-${index}${titleSuffix}`,
        `${instanceId}:${owner}/${repo}#pr-${index}`,
      );
      assertInsideWorktreeCache(worktreesDir, worktreePath);

      // A leftover directory is only reused when it is actually checked out at
      // the current PR head sha; a stale one (PR was updated, or the directory
      // is not a valid worktree) is discarded and recreated below — after
      // confirming when it still holds uncommitted changes or local commits,
      // because the forced removal discards both.
      const inspection = await inspectPrWorktree(worktreePath, headSha);
      if (inspection.state === 'stale') {
        if (!(await this._confirmDiscardStaleWorktree(inspection.info, index))) {
          this._reply('worktreeCancelled', { instanceId, owner, repo, index });
          return;
        }
        await discardStalePrWorktree(sourceRepoPath, worktreePath, inspection.info.branch);
      }
      const worktreeState = inspection.state;

      if (worktreeState === 'current') {
        // The directory is already checked out at the PR head, so this flow
        // *reuses* it — it did not create it in this call, and `inspectPrWorktree`
        // returned before it looked at the local work inside. Nothing here may
        // therefore delete it: the `stale` path above is the one that discards,
        // and only after `_confirmDiscardStaleWorktree` named what that would
        // destroy. See the failure branch below.
        if (!(await this._confirmReplaceWorkspace(worktreePath, openInNewWindow))) {
          this._reply('worktreeCancelled', { instanceId, owner, repo, index });
          return;
        }
        const worktree: WorktreeInfo = {
          id: `${instanceId}:${owner}/${repo}#pr-${index}`,
          instanceId,
          owner,
          repo,
          prIndex: index,
          prTitle,
          headBranch,
          headSha,
          baseBranch,
          sourceRepoPath,
          worktreePath,
          createdAt: Date.now(),
        };
        const openedForCurrent = await openWorktree(
          worktreePath,
          openInNewWindow,
          () => this._worktreeManager.addWorktree(worktree),
          { confirmed: true },
        );
        if (!openedForCurrent) {
          // The folder did not open. This checkout already existed before the
          // call, so it may hold uncommitted changes, untracked or ignored files
          // and local commits that this flow never inspected — discarding it here
          // (as the create path below does with a checkout it just made) would
          // destroy the user's work over a failed *open*. Leave it on disk and
          // report the problem.
          //
          // Record it too, so Settings lists it and its delete action stays
          // reachable: the directory only reaches this branch through a path that
          // found it on disk, which may have been a leftover with no record (the
          // recorded-reopen path returns earlier, the stale path overwrote the
          // record, and `forgetWorktree` drops a record whose directory is gone).
          // Recording must not turn a reported error into a silent one.
          await this._worktreeManager.addWorktree(worktree).catch((error: unknown) => {
            logger.error(
              `openPrWorktree could not record the existing worktree ${worktreePath}: ${userFacingErrorMessage(error)}`,
            );
          });
          this._reply('worktreeError', {
            error: vscode.l10n.t(
              'The worktree folder at {0} could not be opened. The existing checkout, including any uncommitted changes, was left untouched.',
              worktreePath,
            ),
            operation: 'open',
            instanceId,
            owner,
            repo,
            index,
          });
          return;
        }
        // Record only after the user confirmed the open, so a cancelled
        // "replace current window" prompt leaves no stale entry. In
        // current-window mode the beforeOpen callback above already recorded
        // it (the window reloads right after openFolder returns control).
        if (openInNewWindow) {
          await this._worktreeManager.addWorktree(worktree);
        }
        this._reply('worktreeOpened', { worktree, existed: true });
        return;
      }

      // Fetch through the remote that actually points at this repo, not a
      // hardcoded 'origin' (with several remotes it may point elsewhere).
      const remoteName = await resolveRemoteForRepo(sourceRepoPath, instance.url, owner, repo);
      if (!remoteName) {
        this._reply('worktreeError', {
          error: vscode.l10n.t('No git remote in the local repository points at {0}/{1}', owner, repo),
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }

      const localBranch = `pr-${index}-${headSha.slice(0, 7)}`;

      // Confirm the replace-current-workspace modal *before* the checkout is
      // created. Creating it first and recording it only after the prompt left
      // an unrecorded checkout with the throwaway branch checked out whenever
      // the user declined; if that directory was then removed (a cache-directory
      // change, disk cleanup), its git worktree registration survived and every
      // later attempt failed on "refusing to fetch into branch … checked out at
      // <old path>". Declining now leaves no branch and no registration at all.
      if (!(await this._confirmReplaceWorkspace(worktreePath, openInNewWindow))) {
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }

      await fetchPullRequestHead(sourceRepoPath, remoteName, index, localBranch, instance.token);

      // Verify the fetched code is the PR head the API reported. Pull refs are
      // per-repository, so a matching remote serves the right ones; the check
      // catches the remaining drift (PR updated between the API call and the
      // fetch) instead of silently opening stale code.
      const fetchedSha = await getRefCommitSha(sourceRepoPath, localBranch);
      if (fetchedSha !== headSha) {
        await deleteBranch(sourceRepoPath, localBranch).catch(() => undefined);
        this._reply('worktreeError', {
          error: vscode.l10n.t(
            'Fetched PR head does not match commit {0}; the pull request may have been updated, please retry',
            headSha.slice(0, 7),
          ),
          operation: 'open',
          instanceId,
          owner,
          repo,
          index,
        });
        return;
      }

      try {
        await createWorktreeFromBranch(sourceRepoPath, worktreePath, localBranch);
      } catch (error) {
        // The fetch refspec created `localBranch` for this checkout, and a
        // failed `worktree add` does not remove it — the throwaway
        // `pr-<n>-<sha7>` branch would leak in the repository. Drop it here,
        // matching the convention removeWorktree/discardStalePrWorktree
        // follow: only a name matching the throwaway pattern is deleted (a
        // real user branch is never named this way), and the delete is
        // best-effort — a leftover that survives is reclaimed by the
        // stale-registration recovery in fetchPullRequestHead on the next
        // attempt.
        if (PR_THROWAWAY_BRANCH_PATTERN.test(localBranch)) {
          await deleteBranch(sourceRepoPath, localBranch).catch(() => undefined);
        }
        throw error;
      }

      const worktree: WorktreeInfo = {
        id: `${instanceId}:${owner}/${repo}#pr-${index}`,
        instanceId,
        owner,
        repo,
        prIndex: index,
        prTitle,
        headBranch,
        headSha,
        baseBranch,
        sourceRepoPath,
        worktreePath,
        createdAt: Date.now(),
      };
      const openedNew = await openWorktree(
        worktreePath,
        openInNewWindow,
        () => this._worktreeManager.addWorktree(worktree),
        { confirmed: true },
      );
      if (!openedNew) {
        await this._discardDeclinedPrCheckout(sourceRepoPath, worktreePath, localBranch);
        this._reply('worktreeCancelled', { instanceId, owner, repo, index });
        return;
      }
      // Record only after the user confirmed the open, so a cancelled
      // "replace current window" prompt leaves no stale entry. In
      // current-window mode the beforeOpen callback above already recorded
      // it (the window reloads right after openFolder returns control).
      if (openInNewWindow) {
        await this._worktreeManager.addWorktree(worktree);
      }
      this._reply('worktreeOpened', { worktree, existed: false });
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`openPrWorktree failed for ${owner}/${repo}#${index}: ${err}`);
      this._reply('worktreeError', { error: err, operation: 'open', instanceId, owner, repo, index });
    }
  }

  private async _resolveCommitAvatars(
    detail: {
      repository: unknown;
      readme?: string;
      branches: string[];
      recentCommits: Array<{
        sha: string;
        commit: unknown;
        author?: { avatar_url?: string };
        committer?: { avatar_url?: string };
        html_url: string;
      }>;
    },
    instance: ForgejoInstance,
  ): Promise<typeof detail> {
    // Dedupe by URL first: the same author typically appears on most of the
    // listed commits, and each resolution is an HTTP fetch proxied through
    // the host.
    const avatarUrls = new Set<string>();
    for (const commit of detail.recentCommits) {
      if (commit.committer?.avatar_url) {
        avatarUrls.add(commit.committer.avatar_url);
      }
      if (commit.author?.avatar_url) {
        avatarUrls.add(commit.author.avatar_url);
      }
    }
    const resolvedUrls = new Map<string, string>();
    await Promise.all(
      Array.from(avatarUrls).map(async (url) => {
        resolvedUrls.set(url, await this._resolveAvatarUrl(url, instance));
      }),
    );
    const resolvedCommits = detail.recentCommits.map((commit) => {
      const resolved = { ...commit };
      if (commit.committer?.avatar_url) {
        resolved.committer = {
          ...commit.committer,
          avatar_url: resolvedUrls.get(commit.committer.avatar_url) ?? commit.committer.avatar_url,
        };
      }
      if (commit.author?.avatar_url) {
        resolved.author = {
          ...commit.author,
          avatar_url: resolvedUrls.get(commit.author.avatar_url) ?? commit.author.avatar_url,
        };
      }
      return resolved;
    });
    return { ...detail, recentCommits: resolvedCommits };
  }

  private async _resolveAvatarUrl(url: string, instance: ForgejoInstance): Promise<string> {
    // The URL reaches this method from the server's payload, but a relative one
    // is resolved against the instance URL — which may carry the token as
    // userinfo — so every line below logs the redacted form. Only the URL is
    // logged; the resolved value itself is fetched with the token as a header.
    const logUrl = redactUrlUserinfo(url);
    if (!this._view) {
      logger.debug(`[avatar] no view, returning original url: ${logUrl}`);
      return url;
    }
    logger.debug(`[avatar] resolving: ${logUrl}`);
    try {
      // Only same-origin URLs are proxied through the host: avatars on private
      // instances (force-login) need the API token, and the token must never
      // leak to third-party origins. Everything else — gravatar, but also any
      // intranet address a malicious instance plants in avatar_url — is
      // returned as-is for the webview to load directly (its CSP allows
      // https: images), so the host never fetches attacker-chosen targets.
      // Relative URLs resolve against the instance URL and are same-origin.
      // Non-http(s) schemes (e.g. data:) have origin "null" and pass through.
      const parsed = new URL(url, instance.url);
      if (!isSameOrigin(parsed.href, instance.url)) {
        logger.debug(`[avatar] not same-origin, returning original url: ${logUrl}`);
        return url;
      }
      return (await this._fetchAvatarDataUrl(parsed.href, instance)) ?? url;
    } catch (error) {
      const err = userFacingErrorMessage(error);
      logger.error(`[avatar] error resolving ${logUrl}: ${err}`);
      return url;
    }
  }

  /**
   * Fetch a same-origin avatar as a data URL, going through the session-level
   * cache. Returns null (cached briefly) when the fetch fails; the caller
   * falls back to the original URL.
   */
  private _fetchAvatarDataUrl(absoluteUrl: string, instance: ForgejoInstance): Promise<string | null> {
    const cached = getCachedAvatar(absoluteUrl);
    if (cached) {
      return cached;
    }
    const promise = (async (): Promise<string | null> => {
      try {
        // A hung image host must not stall the surrounding Promise.all; on
        // timeout the fetch rejects and the original URL is kept.
        const init: RequestInit = {
          signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
          headers: { Authorization: `token ${instance.token}` },
        };
        // Route through the configured proxy like every other host-side
        // request: without it an instance reachable only through the proxy
        // makes every avatar stall until the 30 s timeout and then fall back to
        // the raw URL. A dispatcher is only understood by the undici fetch that
        // created it, hence the paired helper.
        const response = await (getProxyFetch() ?? fetch)(absoluteUrl, init);
        logger.debug(`[avatar] response status: ${response.status} ${response.statusText}`);
        if (!response.ok) {
          logger.error(`[avatar] fetch failed: ${response.status} ${response.statusText}`);
          return null;
        }
        // A declared size already over the cap makes the body unread: nothing
        // is buffered for a payload that would be dropped afterwards anyway.
        // The URL is same-origin (the caller only passes those) and logged
        // redacted like the other avatar lines.
        const declaredLength = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredLength) && declaredLength > AVATAR_FETCH_MAX_BYTES) {
          logger.error(
            `[avatar] response too large (Content-Length ${declaredLength}), skipping: ${redactUrlUserinfo(absoluteUrl)}`,
          );
          return null;
        }
        // `arrayBuffer()` would buffer the whole body before any budget could
        // apply, so read the stream with a counter instead — the same counting
        // discipline downloadActionArtifactToFile applies with its Transform.
        // A missing or understated Content-Length then still cannot pull an
        // unbounded payload into memory.
        let buffer: Buffer;
        if (response.body) {
          const reader = response.body.getReader();
          const chunks: Uint8Array[] = [];
          let received = 0;
          let tooLarge = false;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                break;
              }
              received += value.byteLength;
              if (received > AVATAR_FETCH_MAX_BYTES) {
                tooLarge = true;
                break;
              }
              chunks.push(value);
            }
          } finally {
            // Cancel on the early exit so the underlying connection is released
            // instead of draining the rest of the body in the background.
            await reader.cancel().catch(() => undefined);
          }
          if (tooLarge) {
            logger.error(
              `[avatar] response body grew past ${AVATAR_FETCH_MAX_BYTES} bytes, skipping: ${redactUrlUserinfo(absoluteUrl)}`,
            );
            return null;
          }
          buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
        } else {
          // No stream to count (a non-standard fetch implementation): read
          // whole, but still enforce the cap on what was buffered.
          buffer = Buffer.from(await response.arrayBuffer());
          if (buffer.byteLength > AVATAR_FETCH_MAX_BYTES) {
            logger.error(
              `[avatar] response too large (${buffer.byteLength} bytes), skipping: ${redactUrlUserinfo(absoluteUrl)}`,
            );
            return null;
          }
        }
        const base64 = buffer.toString('base64');
        const contentType = response.headers.get('content-type') ?? 'image/png';
        logger.debug(`[avatar] resolved to data:${contentType};base64,${base64.slice(0, 40)}...`);
        return `data:${contentType};base64,${base64}`;
      } catch (error) {
        const err = userFacingErrorMessage(error);
        logger.error(`[avatar] error resolving ${redactUrlUserinfo(absoluteUrl)}: ${err}`);
        return null;
      }
    })();
    cacheResolvedAvatar(absoluteUrl, promise);
    return promise;
  }
}
