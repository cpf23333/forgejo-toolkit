import * as fs from 'fs';
import { createHash } from 'crypto';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import * as vscode from 'vscode';
import { buildUrl, client as baseClient, encodePathSegment } from '@cpf23333-forgejo-toolkit/shared/request';
import { toApiError } from './errors';
import { assertActionsSupported } from './serverVersion';
import type { Client, RequestConfig, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
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
import type { Logger } from '../logger';
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
// Safety bound so a misbehaving server cannot keep us fetching forever.
const MAX_PAGES = 10;
// Raw payload caps: CI logs are loaded fully into memory; artifacts stream to
// disk and only carry a large defensive cap against unbounded writes.
const MAX_JOB_LOG_LENGTH = 10 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024 * 1024;
// Guard for the recursive git tree loop against servers that ignore the
// pagination params and keep returning the same page with truncated=true.
const MAX_TREE_PAGES = 50;

/** Per-request timeout: a reachable-but-unresponsive instance must not hang. */
export const API_REQUEST_TIMEOUT_MS = 30_000;

/**
 * Longer budget for large buffered downloads (CI logs up to 10 MB, PR diffs):
 * the generic 30 s cap aborts them mid-transfer on slow networks. Artifact
 * streaming uses an idle watchdog instead of a total cap (see
 * downloadActionArtifactToFile).
 */
export const API_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

// 403 scope toasts are deduped per instance+scope for the whole session.
const shownPermissionErrorKeys = new Set<string>();

interface TreeCacheEntry {
  value: GitEntry[];
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
 * Merge two per-commit statuses of the same file into the net status for the
 * whole compare range. `undefined` means the changes cancel out. Order
 * matters: an added file that is later modified is still a new file (the base
 * side has nothing to fetch), while a removed file that is later re-added
 * exists at both ends with different content.
 */
function mergeCompareStatuses(existing: string, next: string): string | undefined {
  if (existing === 'added' && next === 'removed') {
    return undefined;
  }
  if (existing === 'removed' && next === 'added') {
    return 'modified';
  }
  if (existing === 'added' || existing === 'removed') {
    return existing;
  }
  if (next === 'renamed') {
    return 'renamed';
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

export class ForgejoClient {
  private readonly configuredOrigin: string;
  private detectedServerOrigin: string | undefined;
  private readonly syncApiUrlsToInstanceUrl: boolean;
  // Distinguishes same-origin accounts in the shared tree cache without
  // embedding the raw token in cache keys.
  private readonly tokenCacheKey: string;

  constructor(
    private url: string,
    private token: string,
    private logger?: Logger,
    syncApiUrlsToInstanceUrl?: boolean,
  ) {
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
    assertActionsSupported(this.url);
  }

  /**
   * Fetches every page of a list endpoint. The server may silently clamp the
   * requested limit (MAX_RESPONSE_ITEMS), so the first page's length — not
   * PAGE_SIZE — defines the effective page size: only a shorter later page
   * (or an empty one) means the list is exhausted. X-Total-Count is not
   * available on all endpoints. MAX_PAGES remains the safety bound.
   */
  private async _fetchAllPages<T>(fetchPage: (page: number) => Promise<T[] | null | undefined>): Promise<T[]> {
    const all: T[] = [];
    let effectivePageSize: number | undefined;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const items = (await fetchPage(page)) ?? [];
      all.push(...items);
      if (page === 1) {
        effectivePageSize = items.length;
      }
      if (items.length === 0 || items.length < (effectivePageSize ?? PAGE_SIZE)) {
        break;
      }
    }
    return all;
  }

  getUserStopWatches(): Promise<StopWatch[]> {
    return userGetStopWatches(undefined, { client: this._client() }) as Promise<StopWatch[]>;
  }

  async getUserRepositories(): Promise<ForgejoRepository[]> {
    const repos = await this._fetchAllPages((page) =>
      userCurrentListRepos({ page, limit: PAGE_SIZE }, { client: this._client() }),
    );
    return repos as ForgejoRepository[];
  }

  createUserRepo(data: CreateRepoOption): Promise<Repository> {
    return createCurrentUserRepo(data, { client: this._client() });
  }

  async getUserIssues(state: string = 'open'): Promise<ForgejoIssue[]> {
    const issues = await this._fetchAllPages((page) =>
      issueSearchIssues(
        { state: state as 'open' | 'closed' | 'all', type: 'issues', page, limit: PAGE_SIZE },
        { client: this._client() },
      ),
    );
    return issues as ForgejoIssue[];
  }

  async getUserPullRequests(state: string = 'open'): Promise<ForgejoPullRequest[]> {
    const pulls = await this._fetchAllPages((page) =>
      issueSearchIssues(
        { state: state as 'open' | 'closed' | 'all', type: 'pulls', page, limit: PAGE_SIZE },
        { client: this._client() },
      ),
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
    const result = await listActionRunArtifacts(owner, repo, runId, undefined, { client: this._client() });
    return (
      Array.isArray(result) ? result : ((result as { artifacts?: ActionArtifact[] }).artifacts ?? [])
    ) as ForgejoActionArtifact[];
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

  async getNotifications(
    statusTypes: string[] = ['unread', 'pinned'],
    subjectType?: ('issue' | 'pull' | 'repository')[],
    limit: number = 50,
  ): Promise<ForgejoNotification[]> {
    const notifications = await notifyGetList(
      {
        'status-types': statusTypes,
        ...(subjectType ? { 'subject-type': subjectType } : {}),
        limit,
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

  async getReadme(owner: string, repo: string): Promise<string | undefined> {
    const readmeFile = await this._probe(
      repoGetContents(owner, repo, 'README.md', undefined, { client: this._client() }),
      `getReadme ${owner}/${repo}`,
    );
    return readmeFile?.content ? decodeBase64(readmeFile.content) : undefined;
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
      this.logger?.debug(`[probe] ${what}: ${error instanceof Error ? error.message : String(error)}`);
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

  async getRepoDetail(owner: string, repo: string): Promise<ForgejoRepoDetail> {
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

    const [readme, branches, commits] = await Promise.all([
      this.getReadme(owner, repo),
      repoListBranches(owner, repo, { limit: 10 }, { client: this._client() }),
      repoGetAllCommits(owner, repo, { limit: 10 }, { client: this._client() }),
    ]);

    return {
      repository: repository as ForgejoRepository,
      empty: false,
      readme,
      branches: branches?.map((branch) => branch.name ?? '').filter(Boolean) ?? [],
      recentCommits: (commits ?? []).map(
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
    };
  }

  async getRepoBranchCommits(owner: string, repo: string, branch: string): Promise<ForgejoCommit[]> {
    const commits = await repoGetAllCommits(owner, repo, { sha: branch, limit: 10 }, { client: this._client() });
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

  async getFileHistory(owner: string, repo: string, filepath: string, ref: string): Promise<ForgejoCommit[]> {
    const commits = await repoGetAllCommits(
      owner,
      repo,
      { sha: ref, path: filepath, limit: 50 },
      { client: this._client() },
    );
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
          parents: commit.parents?.map((parent) => ({ sha: parent.sha })),
          files: commit.files?.map((file) => ({ filename: file.filename, status: file.status })),
        }) as ForgejoCommit,
    );
  }

  async getRepoContents(owner: string, repo: string, path: string, ref?: string): Promise<ForgejoContentEntry[]> {
    const params = ref ? { ref } : undefined;
    if (!path) {
      const entries = await repoGetContentsList(owner, repo, params, { client: this._client() });
      return (entries ?? []) as ForgejoContentEntry[];
    }
    const result = await repoGetContents(owner, repo, encodeFilePath(path), params, { client: this._client() });
    const entries = Array.isArray(result) ? result : [result];
    return entries as ForgejoContentEntry[];
  }

  async searchRepoFiles(owner: string, repo: string, ref: string, query: string): Promise<GitEntry[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const tree = await this._getRepoTree(owner, repo, ref);
    const allFiles = tree.filter(
      (entry) => typeof entry.path === 'string' && entry.path.toLowerCase().includes(normalizedQuery),
    );

    return allFiles.sort((a, b) => {
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
  }

  /**
   * Fetches the full recursive git tree (blob entries only) for a ref,
   * serving it from the shared short-lived cache when possible.
   */
  private async _getRepoTree(owner: string, repo: string, ref: string): Promise<GitEntry[]> {
    const key = `${this.configuredOrigin}|${this.tokenCacheKey}|${owner}/${repo}@${ref}`;
    const cached = treeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
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
      truncated = response?.truncated ?? false;
      // Guard against servers that ignore the pagination params and keep
      // returning the same page with truncated=true forever.
      const firstSha = entries[0]?.sha;
      if (entries.length === 0 || (firstSha !== undefined && firstSha === previousFirstSha)) {
        break;
      }
      previousFirstSha = firstSha;
      const files = entries.filter(
        (entry): entry is GitEntry => entry.type === 'blob' && typeof entry.path === 'string',
      );
      allFiles.push(...files);
      if (!truncated) {
        break;
      }
    }

    // A truncated tree may be incomplete, so it is not cached; whatever was
    // returned is still filtered for the current query. Failures are not
    // cached either: an error above propagates before this point.
    if (!truncated) {
      if (treeCache.size >= MAX_TREE_CACHE_ENTRIES) {
        // Map iteration order is insertion order: the first key is the oldest.
        const oldest = treeCache.keys().next().value;
        if (oldest !== undefined) {
          treeCache.delete(oldest);
        }
      }
      treeCache.set(key, { value: allFiles, expiresAt: Date.now() + TREE_CACHE_TTL_MS });
    }
    return allFiles;
  }

  async getRepoBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    const branches = await this._fetchAllPages((page) =>
      repoListBranches(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
    );
    return branches as ForgejoBranch[];
  }

  async getRepoTags(owner: string, repo: string): Promise<ForgejoTag[]> {
    const tags = await this._fetchAllPages((page) =>
      repoListTags(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
    );
    return tags as ForgejoTag[];
  }

  async getRepoReleases(owner: string, repo: string): Promise<ForgejoRelease[]> {
    const releases = await this._fetchAllPages((page) =>
      repoListReleases(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
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

  async getPullRequestDetail(owner: string, repo: string, index: number): Promise<ForgejoPullRequestDetail> {
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
    const [protection, combinedStatus] = await Promise.all([
      baseRef
        ? this._probe(
            repoGetBranchProtection(owner, repo, encodePathSegment(baseRef), { client: this._client() }),
            `branch protection ${owner}/${repo}@${baseRef}`,
          )
        : undefined,
      headSha
        ? this._probe(
            repoGetCombinedStatusByRef(owner, repo, encodePathSegment(headSha), undefined, {
              client: this._client(),
            }),
            `combined status ${owner}/${repo}@${headSha}`,
          )
        : undefined,
    ]);
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
      approvedCount = (reviews ?? []).filter(
        (review) => review.state === 'APPROVED' && review.official === true && !review.stale && !review.dismissed,
      ).length;
    }
    const mergeBlockers = this._buildMergeBlockers(prDetail, permissions, protection, combinedStatus, approvedCount);
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
      repoPermissions: permissions,
      mergeBlockers,
      statusChecks,
    };
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
    if (!permissions?.admin && !permissions?.push) {
      blockers.push({ type: 'no_permission' });
    }

    const canBypassProtection = permissions?.admin === true && protection?.apply_to_admins !== true;
    if (protection && !canBypassProtection) {
      const requiredApprovals = protection.required_approvals;
      if (requiredApprovals && requiredApprovals > 0 && (approvedCount ?? 0) < requiredApprovals) {
        blockers.push({ type: 'required_approvals', requiredApprovals });
      }
      if (protection.enable_status_check && (protection.status_check_contexts?.length ?? 0) > 0) {
        const state = combinedStatus?.state;
        if (state !== 'success') {
          blockers.push({ type: 'required_status_checks', statusState: state });
        }
      }
    }

    if (pr.mergeable === false && !blockers.some((b) => b.type === 'required_status_checks')) {
      blockers.push({ type: 'conflicts' });
    }

    return blockers;
  }

  async getRepoIssues(owner: string, repo: string, state: string = 'open', query?: string): Promise<ForgejoIssue[]> {
    const q = query?.trim();
    const issues = await this._fetchAllPages((page) =>
      issueListIssues(
        owner,
        repo,
        { state: state as 'open' | 'closed' | 'all', type: 'issues', ...(q ? { q } : {}), page, limit: PAGE_SIZE },
        { client: this._client() },
      ),
    );
    return issues as ForgejoIssue[];
  }

  async getRepoLabels(owner: string, repo: string): Promise<Label[]> {
    const labels = await this._fetchAllPages((page) =>
      issueListLabels(owner, repo, { page, limit: PAGE_SIZE }, { client: this._client() }),
    );
    return labels as Label[];
  }

  async getRepoAssignees(owner: string, repo: string): Promise<string[]> {
    const users = await repoGetAssignees(owner, repo, { client: this._client() });
    return ((users ?? []) as User[]).map((user) => user.login ?? '').filter(Boolean);
  }

  async getRepoMilestones(owner: string, repo: string): Promise<Milestone[]> {
    const milestones = await this._fetchAllPages((page) =>
      issueGetMilestonesList(owner, repo, { state: 'open', page, limit: PAGE_SIZE }, { client: this._client() }),
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
    const user = await this._probe(userGet(username, { client: this._client() }), `getUserPreview ${username}`);
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
      const pulls = await this._fetchAllPages((page) =>
        issueListIssues(
          owner,
          repo,
          { state: state as 'open' | 'closed' | 'all', type: 'pulls', q, page, limit: PAGE_SIZE },
          { client: this._client() },
        ),
      );
      return pulls as ForgejoPullRequest[];
    }
    const pulls = await this._fetchAllPages((page) =>
      repoListPullRequests(
        owner,
        repo,
        { state: state as 'open' | 'closed' | 'all', page, limit: PAGE_SIZE },
        {
          client: this._client(),
        },
      ),
    );
    return pulls as ForgejoPullRequest[];
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
    return issueAddSubscription(owner, repo, index, user, { client: this._client() });
  }

  deleteIssueSubscription(owner: string, repo: string, index: number, user: string): Promise<unknown> {
    return issueDeleteSubscription(owner, repo, index, user, { client: this._client() });
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

  listIssueTrackedTimes(owner: string, repo: string, index: number): Promise<TrackedTime[]> {
    return issueTrackedTimes(owner, repo, index, undefined, { client: this._client() }) as Promise<TrackedTime[]>;
  }

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

  listIssueDependencies(owner: string, repo: string, index: number): Promise<ForgejoIssue[]> {
    return issueListIssueDependencies(owner, repo, index, undefined, { client: this._client() }) as Promise<
      ForgejoIssue[]
    >;
  }

  createIssueDependency(owner: string, repo: string, index: number, dependencyIndex: number): Promise<unknown> {
    const data: IssueMeta = { index: dependencyIndex, owner, repo };
    return issueCreateIssueDependencies(owner, repo, index, data, { client: this._client() });
  }

  removeIssueDependency(owner: string, repo: string, index: number, dependencyIndex: number): Promise<unknown> {
    const data: IssueMeta = { index: dependencyIndex, owner, repo };
    return issueRemoveIssueDependencies(owner, repo, index, data, { client: this._client() });
  }

  getIssueReactions(owner: string, repo: string, index: number): Promise<Reaction[]> {
    return issueGetIssueReactions(owner, repo, index, undefined, { client: this._client() }) as Promise<Reaction[]>;
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
        uuid?: string;
        name?: string;
        size?: number;
        browser_download_url?: string;
      };
      return {
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

  async getFileContent(owner: string, repo: string, filepath: string, ref: string): Promise<string> {
    const response = await repoGetContents(owner, repo, encodeFilePath(filepath), { ref }, { client: this._client() });
    const content = (response as { content?: string }).content;
    if (!content) {
      return '';
    }
    return decodeBase64(content);
  }

  async getPullRequestFiles(owner: string, repo: string, index: number): Promise<ForgejoChangedFile[]> {
    const files = await this._fetchAllPages((page) =>
      repoGetPullRequestFiles(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
    );
    // The API spells a deleted file's status 'deleted' (the compare endpoint
    // uses 'removed'); consumers only recognize 'removed', so normalize here.
    return (files as ForgejoChangedFile[]).map((file) =>
      file.status === 'deleted' ? { ...file, status: 'removed' } : file,
    );
  }

  async getPullRequestFilesFromCompare(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<ForgejoChangedFile[]> {
    const compare = await repoCompareDiff(owner, repo, `${baseSha}..${headSha}`, { client: this._client() });
    const statusMap = new Map<string, string>();
    const previousNameMap = new Map<string, string>();
    // The generated CommitAffectedFiles type predates the field; the compare
    // endpoint does return previous_filename for renamed files.
    const compareFiles = (compare.files ?? []) as Array<{
      filename?: string;
      status?: string;
      previous_filename?: string;
    }>;
    for (const file of compareFiles) {
      const filename = file.filename ?? '';
      if (!filename) {
        continue;
      }
      // Renamed files need their old path to fetch the base-side content.
      if (file.previous_filename) {
        previousNameMap.set(filename, file.previous_filename);
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
    return Array.from(statusMap.entries()).map(
      ([filename, status]) =>
        ({
          filename,
          status,
          previous_filename: previousNameMap.get(filename),
          additions: 0,
          deletions: 0,
          changes: 0,
        }) as ForgejoChangedFile,
    );
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
    );
    // Body-reference heuristic: only comments whose body links an attachment
    // (see ATTACHMENT_REFERENCE_REGEX) get an attachment-list request, instead
    // of one API call per comment. Note the behavior change: attachments that
    // were uploaded but later unlinked from the body are no longer listed.
    const commentIds = comments
      .filter((c) => c.id !== undefined && ATTACHMENT_REFERENCE_REGEX.test(c.body ?? ''))
      .map((c) => c.id as number);
    const assetsMap = new Map<number, ForgejoIssueAttachment[]>();
    await Promise.all(
      commentIds.map(async (commentId) => {
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
          this.logger?.debug(
            `[probe] comment assets for #${commentId}: ${error instanceof Error ? error.message : String(error)}`,
          );
          assetsMap.set(commentId, []);
        }
      }),
    );
    return comments.map((c) => {
      if (c.id === undefined) {
        return c;
      }
      return { ...c, assets: assetsMap.get(c.id) ?? [] };
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
    const commits = await this._fetchAllPages((page) =>
      repoGetPullRequestCommits(
        owner,
        repo,
        index,
        { files: true, page, limit: PAGE_SIZE },
        { client: this._client() },
      ),
    );
    return commits as Commit[];
  }

  mergePullRequest(owner: string, repo: string, index: number, strategy: 'merge' | 'rebase' | 'squash'): Promise<void> {
    return repoMergePullRequest(owner, repo, index, { Do: strategy }, { client: this._client() }) as Promise<void>;
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
    const result = await this._fetchAllPages((page) =>
      repoListPullReviews(owner, repo, index, { page, limit: PAGE_SIZE }, { client: this._client() }),
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

    if (this.detectedServerOrigin === undefined) {
      const detected = this._detectServerOrigin(data);
      if (!detected) {
        return data;
      }
      this.detectedServerOrigin = detected;
    }

    return this._rewriteUrls(data, this.detectedServerOrigin, this.configuredOrigin);
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

  private _client(): Client {
    const baseURL = `${this.url.replace(/\/$/, '')}/api/v1`;

    return async <TResponseData, _TError = unknown, TRequestData = unknown>(
      config: RequestConfig<TRequestData>,
    ): Promise<ResponseConfig<TResponseData>> => {
      const method = config.method ?? 'GET';
      // Serialize via the same helper the base client uses, so the logged URL
      // matches the actual request (array params repeat the key).
      const targetUrl = buildUrl({ ...config, baseURL });
      const debugEnabled = this.logger?.isDebugEnabled() ?? false;
      const start = debugEnabled ? Date.now() : 0;
      this.logger?.debug(`Request: ${method} ${targetUrl}`);

      try {
        const response = await baseClient<TResponseData>({
          ...config,
          baseURL,
          // A reachable-but-unresponsive instance must not hang the request
          // forever; callers may still pass their own signal.
          signal: config.signal ?? AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
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
          this.logger?.debug(`Request failed after ${duration}ms: ${method} ${targetUrl}`);
        }
        if (error instanceof Error) {
          this._notifyIfPermissionError(error.message);
        }
        // Normalize into a structured ApiError: message stays raw for logs and
        // pattern matching, userMessage carries the localized rendering.
        throw toApiError(error);
      }
    };
  }

  private _notifyIfPermissionError(errorMessage: string) {
    const match = errorMessage.match(/Forgejo API error (\d+):\s*([\s\S]+)/);
    if (!match) {
      return;
    }
    const [, status, body] = match;
    const text = body.trim();

    const openTokenSettings = vscode.l10n.t('Open Token Settings');
    const openSettings = vscode.l10n.t('Open Settings');
    const notify = (key: string, message: string) => {
      // One toast per instance+reason per session: pollers and manual
      // refreshes would otherwise re-toast the same failure on every request.
      if (shownPermissionErrorKeys.has(key)) {
        return;
      }
      shownPermissionErrorKeys.add(key);
      void vscode.window.showErrorMessage(message, openTokenSettings, openSettings).then((choice) => {
        if (choice === openTokenSettings) {
          const tokenSettingsUrl = `${this.url.replace(/\/$/, '')}/user/settings/applications`;
          void vscode.env.openExternal(vscode.Uri.parse(tokenSettingsUrl));
        } else if (choice === openSettings) {
          void vscode.commands.executeCommand('forgejoToolkit.openSettings');
        }
      });
    };

    if (status === '401') {
      // The token was rejected outright (deleted, expired, or the instance
      // was reinstalled): point the user at the token page and the instance
      // edit form instead of leaving them with a bare error.
      notify(
        `${this.url}|401`,
        vscode.l10n.t('Invalid or expired credentials for {0}. Update the access token.', this.url),
      );
      return;
    }

    if (status !== '403' || !/required scope|token does not have/i.test(text)) {
      return;
    }
    // Forgejo names the missing scope in the error body ("token does not have
    // at least one of required scope(s): [write:issue]"); surface it so the
    // user knows exactly which scope to grant.
    const scopeMatch = text.match(/required scope\(s\): \[([^\]]+)\]/i);
    const message = scopeMatch
      ? vscode.l10n.t(
          'Permission denied by {0}: the access token lacks the required scope {1}.',
          this.url,
          scopeMatch[1],
        )
      : vscode.l10n.t('Permission denied by {0}: {1}. The access token may lack the required scope.', this.url, text);
    notify(`${this.url}|${text}`, message);
  }
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

// The generated API clients interpolate path parameters into the URL without
// any encoding (they build the path via plain template literals), so values
// coming from repository data — branch names, tags, refs, file paths — would
// corrupt the request path when they contain `/`, `#` or `?`. Encoding at the
// call layer is safe from double encoding because the generated code never
// encodes itself.
//
// Single-segment params (branch/tag/ref) use encodePathSegment, i.e. full
// encodeURIComponent. Forgejo's router decodes %2F before matching and the
// branch/tag endpoints use wildcard routes, so `release/1.0` works there.
// Endpoints with non-wildcard routes (e.g. git/trees/{sha}) may still 404
// for refs containing `/` — a server-side routing limitation that raw
// interpolation did not handle either.
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
