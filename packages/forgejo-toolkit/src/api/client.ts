import * as vscode from 'vscode';
import { client as baseClient } from '@cpf23333-forgejo-toolkit/shared/request';
import type { Client, RequestConfig, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
import {
  issueCreateIssue,
  issueCreateIssueAttachment,
  issueDeleteIssueAttachment,
  issueEditIssue,
  issueGetCommentsAndTimeline,
  issueGetIssue,
  issueListIssues,
  issueSearchIssues,
  repoCompareDiff,
  repoCreatePullRequest,
  repoEditPullRequest,
  repoGet,
  repoGetAllCommits,
  repoGetContents,
  repoGetContentsList,
  repoGetPullRequest,
  repoGetPullRequestCommits,
  repoGetPullRequestFiles,
  repoListBranches,
  repoListPullRequests,
  userCurrentListRepos,
  userGetCurrent,
} from '@cpf23333-forgejo-toolkit/api';

import type {
  Commit,
  CreateIssueOption,
  CreatePullRequestOption,
  EditIssueOption,
  EditPullRequestOption,
  TimelineComment,
} from '@cpf23333-forgejo-toolkit/api';
import type { Logger } from '../logger';
import type {
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoContentEntry,
  ForgejoIssue,
  ForgejoIssueAttachment,
  ForgejoIssueDetail,
  ForgejoPullRequest,
  ForgejoPullRequestDetail,
  ForgejoRepoDetail,
  ForgejoRepository,
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

  getIssueDetail(owner: string, repo: string, index: number): Promise<ForgejoIssueDetail> {
    return issueGetIssue(owner, repo, index, { client: this._client() }) as Promise<ForgejoIssueDetail>;
  }

  async getPullRequestDetail(owner: string, repo: string, index: number): Promise<ForgejoPullRequestDetail> {
    // WORKAROUND: Forgejo's pulls endpoint does not return attachments.
    // The same underlying object is accessible via the issues endpoint,
    // which does include the `assets` field. See KNOWN_ISSUES.md.
    const [pr, issue] = await Promise.all([
      repoGetPullRequest(owner, repo, index, { client: this._client() }),
      issueGetIssue(owner, repo, index, { client: this._client() }).catch(() => undefined),
    ]);
    return {
      ...(pr as ForgejoPullRequestDetail),
      assets: (issue as ForgejoIssueDetail | undefined)?.assets,
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

  getPullRequestCommentsAndTimeline(owner: string, repo: string, index: number): Promise<TimelineComment[]> {
    return issueGetCommentsAndTimeline(owner, repo, index, { limit: 100 }, { client: this._client() }) as Promise<
      TimelineComment[]
    >;
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
