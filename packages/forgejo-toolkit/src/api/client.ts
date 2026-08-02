import * as vscode from 'vscode';
import { client as baseClient } from '@cpf23333-forgejo-toolkit/shared/request';
import type { Client, RequestConfig, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
import {
  getTree,
  issueCreateComment,
  issueCreateIssue,
  issueCreateIssueAttachment,
  issueCreateIssueCommentAttachment,
  issueDeleteComment,
  issueDeleteIssueAttachment,
  issueDeleteIssueCommentAttachment,
  issueEditComment,
  issueEditIssue,
  issueGetCommentsAndTimeline,
  issueGetIssue,
  issueListIssueCommentAttachments,
  issueListIssues,
  issueSearchIssues,
  repoCompareDiff,
  repoCreateBranch,
  repoCreatePullRequest,
  repoCreateRelease,
  repoCreateReleaseAttachment,
  repoCreateTag,
  repoDeleteBranch,
  repoDeleteRelease,
  repoDeleteReleaseAttachment,
  repoDeleteTag,
  repoEditPullRequest,
  repoEditRelease,
  repoGet,
  repoGetAllCommits,
  repoGetContents,
  repoGetContentsList,
  repoGetPullRequest,
  repoGetPullRequestCommits,
  repoGetPullRequestFiles,
  repoListBranches,
  repoListPullRequests,
  repoListReleases,
  repoListTags,
  repoMergePullRequest,
  userCurrentListRepos,
  userGetCurrent,
} from '@cpf23333-forgejo-toolkit/api';

import type {
  Attachment,
  Commit,
  CreateBranchRepoOption,
  CreateIssueOption,
  CreatePullRequestOption,
  CreateReleaseOption,
  CreateTagOption,
  EditIssueOption,
  EditPullRequestOption,
  EditReleaseOption,
  GitEntry,
  TimelineComment,
} from '@cpf23333-forgejo-toolkit/api';
import type { Logger } from '../logger';
import type {
  ForgejoBranch,
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoContentEntry,
  ForgejoIssue,
  ForgejoIssueAttachment,
  ForgejoIssueDetail,
  ForgejoPullRequest,
  ForgejoPullRequestDetail,
  ForgejoRelease,
  ForgejoRepoDetail,
  ForgejoRepository,
  ForgejoTag,
  ForgejoUser,
} from './types';

export class ForgejoClient {
  constructor(
    private url: string,
    private token: string,
    private logger?: Logger,
  ) {}

  getCurrentUser(): Promise<ForgejoUser> {
    return userGetCurrent({ client: this._client() }) as Promise<ForgejoUser>;
  }

  getUserRepositories(): Promise<ForgejoRepository[]> {
    return userCurrentListRepos({ limit: 100 }, { client: this._client() }) as Promise<ForgejoRepository[]>;
  }

  getUserIssues(state: string = 'open'): Promise<ForgejoIssue[]> {
    return issueSearchIssues(
      { state: state as 'open' | 'closed' | 'all', type: 'issues' },
      { client: this._client() },
    ) as Promise<ForgejoIssue[]>;
  }

  getUserPullRequests(state: string = 'open'): Promise<ForgejoPullRequest[]> {
    return issueSearchIssues(
      { state: state as 'open' | 'closed' | 'all', type: 'pulls' },
      { client: this._client() },
    ) as Promise<ForgejoPullRequest[]>;
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
    const result = await repoGetContents(owner, repo, path, params, { client: this._client() });
    const entries = Array.isArray(result) ? result : [result];
    return entries as ForgejoContentEntry[];
  }

  async searchRepoFiles(owner: string, repo: string, ref: string, query: string): Promise<GitEntry[]> {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
      return [];
    }

    const allFiles: GitEntry[] = [];
    let page = 1;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response = await getTree(
        owner,
        repo,
        ref,
        { recursive: true, page, per_page: 100 },
        { client: this._client() },
      );
      const files = (response?.tree ?? []).filter(
        (entry): entry is GitEntry =>
          entry.type === 'blob' && typeof entry.path === 'string' && entry.path.toLowerCase().includes(normalizedQuery),
      );
      allFiles.push(...files);
      if (!(response?.truncated ?? false)) {
        break;
      }
      page += 1;
    }

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

  async getRepoBranches(owner: string, repo: string): Promise<ForgejoBranch[]> {
    const branches = await repoListBranches(owner, repo, { limit: 100 }, { client: this._client() });
    return (branches ?? []) as ForgejoBranch[];
  }

  async getRepoTags(owner: string, repo: string): Promise<ForgejoTag[]> {
    const tags = await repoListTags(owner, repo, { limit: 100 }, { client: this._client() });
    return (tags ?? []) as ForgejoTag[];
  }

  async getRepoReleases(owner: string, repo: string): Promise<ForgejoRelease[]> {
    const releases = await repoListReleases(owner, repo, { limit: 100 }, { client: this._client() });
    return (releases ?? []) as ForgejoRelease[];
  }

  createBranch(owner: string, repo: string, data: CreateBranchRepoOption): Promise<ForgejoBranch> {
    return repoCreateBranch(owner, repo, data, { client: this._client() }) as Promise<ForgejoBranch>;
  }

  deleteBranch(owner: string, repo: string, branch: string): Promise<void> {
    return repoDeleteBranch(owner, repo, branch, { client: this._client() }) as Promise<void>;
  }

  createTag(owner: string, repo: string, data: CreateTagOption): Promise<ForgejoTag> {
    return repoCreateTag(owner, repo, data, { client: this._client() }) as Promise<ForgejoTag>;
  }

  deleteTag(owner: string, repo: string, tag: string): Promise<void> {
    return repoDeleteTag(owner, repo, tag, { client: this._client() }) as Promise<void>;
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
    const attachment = new File([file.buffer as ArrayBuffer], filename);
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
    return {
      ...(pr as ForgejoPullRequestDetail),
      assets: (issue as ForgejoIssueDetail | undefined)?.assets,
      repoPermissions: permissions,
    };
  }

  getRepoIssues(owner: string, repo: string, state: string = 'open'): Promise<ForgejoIssue[]> {
    return issueListIssues(
      owner,
      repo,
      { state: state as 'open' | 'closed' | 'all', type: 'issues' },
      { client: this._client() },
    ) as Promise<ForgejoIssue[]>;
  }

  getRepoPullRequests(owner: string, repo: string, state: string = 'open'): Promise<ForgejoPullRequest[]> {
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

  createIssueAttachment(
    owner: string,
    repo: string,
    index: number,
    file: Uint8Array,
    filename: string,
  ): Promise<ForgejoIssueAttachment> {
    const attachment = new File([file.buffer as ArrayBuffer], filename);
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
    const response = await repoGetContents(owner, repo, filepath, { ref }, { client: this._client() });
    const content = (response as { content?: string }).content;
    if (!content) {
      return '';
    }
    return decodeBase64(content);
  }

  getPullRequestFiles(owner: string, repo: string, index: number): Promise<ForgejoChangedFile[]> {
    return repoGetPullRequestFiles(
      owner,
      repo,
      index,
      { limit: 100 },
      {
        client: this._client(),
      },
    ) as Promise<ForgejoChangedFile[]>;
  }

  async getPullRequestFilesFromCompare(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<ForgejoChangedFile[]> {
    const compare = await repoCompareDiff(owner, repo, `${baseSha}..${headSha}`, { client: this._client() });
    const statusMap = new Map<string, string>();
    for (const file of compare.files ?? []) {
      const filename = file.filename ?? '';
      if (!filename) {
        continue;
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
          additions: 0,
          deletions: 0,
          changes: 0,
        }) as ForgejoChangedFile,
    );
  }

  async getPullRequestCommentsAndTimeline(owner: string, repo: string, index: number): Promise<TimelineComment[]> {
    const comments = (await issueGetCommentsAndTimeline(
      owner,
      repo,
      index,
      { limit: 100 },
      { client: this._client() },
    )) as TimelineComment[];
    const commentIds = comments.map((c) => c.id).filter((id): id is number => id !== undefined);
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
    const attachment = new File([file.buffer as ArrayBuffer], filename);
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

  getPullRequestCommits(owner: string, repo: string, index: number): Promise<Commit[]> {
    return repoGetPullRequestCommits(
      owner,
      repo,
      index,
      { files: true, limit: 100 },
      { client: this._client() },
    ) as Promise<Commit[]>;
  }

  mergePullRequest(owner: string, repo: string, index: number, strategy: 'merge' | 'rebase' | 'squash'): Promise<void> {
    return repoMergePullRequest(owner, repo, index, { Do: strategy }, { client: this._client() }) as Promise<void>;
  }

  async renderMarkdown(text: string, context?: string): Promise<string> {
    const baseURL = `${this.url.replace(/\/$/, '')}/api/v1`;
    const response = await fetch(`${baseURL}/markdown`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/html',
        Authorization: `token ${this.token}`,
      },
      body: JSON.stringify({ Text: text, Mode: 'gfm', Context: context }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Forgejo API error ${response.status}: ${text || response.statusText}`);
    }
    return response.text();
  }

  private _client(): Client {
    const baseURL = `${this.url.replace(/\/$/, '')}/api/v1`;

    return async <TResponseData, _TError = unknown, TRequestData = unknown>(
      config: RequestConfig<TRequestData>,
    ): Promise<ResponseConfig<TResponseData>> => {
      const method = config.method ?? 'GET';
      const targetUrl = this._buildDebugUrl(baseURL, config);
      this.logger?.debug(`Request: ${method} ${targetUrl}`);

      try {
        const response = await baseClient<TResponseData>({
          ...config,
          baseURL,
          headers: mergeHeaders(config.headers, { Authorization: `token ${this.token}` }),
        });

        this.logger?.debug(`Response: ${response.status} ${response.statusText}`);
        this.logger?.debug(`Response body: ${JSON.stringify(response.data).slice(0, 2000)}`);

        return response;
      } catch (error) {
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

  private _buildDebugUrl(baseURL: string, config: RequestConfig): string {
    const params = config.params ? new URLSearchParams() : undefined;
    if (params) {
      for (const [key, value] of Object.entries(config.params!)) {
        if (value !== undefined && value !== null) {
          params.append(key, String(value));
        }
      }
    }
    const query = params?.toString();
    return `${baseURL}${config.url ?? ''}${query ? `?${query}` : ''}`;
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
