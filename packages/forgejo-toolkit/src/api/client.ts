import * as vscode from 'vscode';
import { buildUrl, client as baseClient, encodePathSegment } from '@cpf23333-forgejo-toolkit/shared/request';
import type { Client, RequestConfig, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
import {
  createCurrentUserRepo,
  getTree,
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
// Raw payload caps: CI logs and artifacts are loaded fully into memory.
const MAX_JOB_LOG_LENGTH = 10 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
// Guard for the recursive git tree loop against servers that ignore the
// pagination params and keep returning the same page with truncated=true.
const MAX_TREE_PAGES = 50;

interface TreeCacheEntry {
  value: GitEntry[];
  expiresAt: number;
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
  // Short-lived cache of the recursive git tree per ref, so debounced file
  // searches do not refetch every page on each keystroke.
  private readonly _treeCache = new Map<string, TreeCacheEntry>();

  constructor(
    private url: string,
    private token: string,
    private logger?: Logger,
    syncApiUrlsToInstanceUrl?: boolean,
  ) {
    this.configuredOrigin = new URL(this.url.replace(/\/$/, '')).origin;
    this.syncApiUrlsToInstanceUrl = syncApiUrlsToInstanceUrl ?? true;
  }

  getCurrentUser(): Promise<ForgejoUser> {
    return userGetCurrent({ client: this._client() }) as Promise<ForgejoUser>;
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
    return listActionRuns(owner, repo, { page, limit }, { client: this._client() }) as Promise<ForgejoActionRunList>;
  }

  async getActionRun(owner: string, repo: string, runId: number): Promise<ActionRun> {
    return actionRun(owner, repo, runId, { client: this._client() }) as Promise<ActionRun>;
  }

  async getActionRunJobs(owner: string, repo: string, runId: number): Promise<ForgejoActionRunJob[]> {
    const result = await listActionRunJobs(owner, repo, runId, { client: this._client() });
    return (
      Array.isArray(result) ? result : ((result as { jobs?: ActionRunJob[] }).jobs ?? [])
    ) as ForgejoActionRunJob[];
  }

  async getActionRunArtifacts(owner: string, repo: string, runId: number): Promise<ForgejoActionArtifact[]> {
    const result = await listActionRunArtifacts(owner, repo, runId, undefined, { client: this._client() });
    return (
      Array.isArray(result) ? result : ((result as { artifacts?: ActionArtifact[] }).artifacts ?? [])
    ) as ForgejoActionArtifact[];
  }

  async getActionJobLog(owner: string, repo: string, jobId: number): Promise<string> {
    const response = await repoGetActionJobLogs(owner, repo, jobId, undefined, {
      client: this._client(),
      responseType: 'text',
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
    await cancelActionRun(owner, repo, runId, { client: this._client() });
  }

  async downloadActionArtifact(owner: string, repo: string, artifactId: number): Promise<Uint8Array> {
    const response = await downloadActionArtifact(owner, repo, artifactId, {
      client: this._client(),
      responseType: 'arraybuffer',
    });
    const bytes = new Uint8Array(response as unknown as ArrayBuffer);
    // Artifacts are loaded fully into memory; refuse unreasonably large ones.
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      throw new Error(`Forgejo artifact ${artifactId} exceeds the 50 MB size limit and was not downloaded.`);
    }
    return bytes;
  }

  async deleteActionRun(owner: string, repo: string, runId: number): Promise<void> {
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
    const readmeFile = await repoGetContents(owner, repo, 'README.md', undefined, {
      client: this._client(),
    }).catch(() => undefined);
    return readmeFile?.content ? decodeBase64(readmeFile.content) : undefined;
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
   * serving it from a short-lived cache when possible.
   */
  private async _getRepoTree(owner: string, repo: string, ref: string): Promise<GitEntry[]> {
    const key = `${owner}/${repo}@${ref}`;
    const cached = this._treeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }
    this._treeCache.delete(key);

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
      this._treeCache.set(key, { value: allFiles, expiresAt: Date.now() + TREE_CACHE_TTL_MS });
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
      repoGet(owner, repo, { client: this._client() }).catch(() => undefined),
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
      issueGetIssue(owner, repo, index, { client: this._client() }).catch(() => undefined),
      repoGet(owner, repo, { client: this._client() }).catch(() => undefined),
    ]);
    const permissions = (repoInfo as { permissions?: { admin?: boolean; push?: boolean; pull?: boolean } } | undefined)
      ?.permissions;
    const prDetail = pr as ForgejoPullRequestDetail;
    const baseRef = prDetail.base?.ref;
    const headSha = prDetail.head?.sha;
    const [protection, combinedStatus] = await Promise.all([
      baseRef
        ? repoGetBranchProtection(owner, repo, encodePathSegment(baseRef), { client: this._client() }).catch(
            () => undefined,
          )
        : undefined,
      headSha
        ? repoGetCombinedStatusByRef(owner, repo, encodePathSegment(headSha), undefined, {
            client: this._client(),
          }).catch(() => undefined)
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
      const reviews = await this.listPullReviews(owner, repo, index).catch(() => undefined);
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

  getRepoIssues(owner: string, repo: string, state: string = 'open', query?: string): Promise<ForgejoIssue[]> {
    const q = query?.trim();
    return issueListIssues(
      owner,
      repo,
      { state: state as 'open' | 'closed' | 'all', type: 'issues', ...(q ? { q } : {}) },
      { client: this._client() },
    ) as Promise<ForgejoIssue[]>;
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
    const user = await userGet(username, { client: this._client() }).catch(() => undefined);
    return user as ForgejoUser | undefined;
  }

  async getIssuePreview(owner: string, repo: string, index: number): Promise<ForgejoIssue | undefined> {
    const issue = await issueGetIssue(owner, repo, index, { client: this._client() }).catch(() => undefined);
    return issue as ForgejoIssue | undefined;
  }

  getRepoPullRequests(
    owner: string,
    repo: string,
    state: string = 'open',
    query?: string,
  ): Promise<ForgejoPullRequest[]> {
    const q = query?.trim();
    if (q) {
      // repoListPullRequests has no keyword filter; the issues endpoint supports `q` with `type=pulls`.
      return issueListIssues(
        owner,
        repo,
        { state: state as 'open' | 'closed' | 'all', type: 'pulls', q },
        { client: this._client() },
      ) as Promise<ForgejoPullRequest[]>;
    }
    return repoListPullRequests(
      owner,
      repo,
      { state: state as 'open' | 'closed' | 'all' },
      { client: this._client() },
    ) as Promise<ForgejoPullRequest[]>;
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
        // If a file is both added and removed across commits, the net change is zero.
        if ((existing === 'added' && status === 'removed') || (existing === 'removed' && status === 'added')) {
          statusMap.delete(filename);
          continue;
        }
        // Prefer more specific statuses over generic 'changed'.
        if (existing === 'changed' || status === 'modified' || status === 'renamed') {
          statusMap.set(filename, status);
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
        } catch {
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

    const visit = (value: unknown) => {
      if (typeof value === 'string') {
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
        for (const item of Object.values(value)) visit(item);
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
          data: this._rewriteResponseData(response.data),
        };
      } catch (error) {
        if (debugEnabled) {
          const duration = Date.now() - start;
          this.logger?.debug(`Request failed after ${duration}ms: ${method} ${targetUrl}`);
        }
        if (error instanceof Error) {
          this._notifyIfPermissionError(error.message);
        }
        throw error;
      }
    };
  }

  private _notifyIfPermissionError(errorMessage: string) {
    const match = errorMessage.match(/Forgejo API error (\d+):\s*(.+)/);
    if (!match) {
      return;
    }
    const [, status, body] = match;
    if (status !== '403') {
      return;
    }
    const text = body.trim();
    if (/required scope|token does not have/i.test(text)) {
      vscode.window.showErrorMessage(`Forgejo permission error: ${text}`);
    }
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
