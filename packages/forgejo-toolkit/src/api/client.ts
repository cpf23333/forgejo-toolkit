import { client as baseClient } from '@cpf23333-forgejo-toolkit/shared/request';
import type { Client, RequestConfig, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
import {
  issueGetIssue,
  issueListIssues,
  issueSearchIssues,
  repoGet,
  repoGetAllCommits,
  repoGetContents,
  repoGetPullRequest,
  repoGetPullRequestFiles,
  repoListBranches,
  repoListPullRequests,
  userCurrentListRepos,
  userGetCurrent,
} from '@cpf23333-forgejo-toolkit/api';
import type { Logger } from '../logger';
import type {
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoIssue,
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

  async getFileContent(owner: string, repo: string, filepath: string, ref: string): Promise<string> {
    const response = await repoGetContents(owner, repo, filepath, { ref }, { client: this._client() });
    const content = (response as { content?: string }).content;
    if (!content) {
      return '';
    }
    return decodeBase64(content);
  }

  getPullRequestFiles(owner: string, repo: string, index: number): Promise<ForgejoChangedFile[]> {
    return repoGetPullRequestFiles(owner, repo, index, undefined, {
      client: this._client(),
    }) as Promise<ForgejoChangedFile[]>;
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

      const response = await baseClient<TResponseData>({
        ...config,
        baseURL,
        headers: mergeHeaders(config.headers, { Authorization: `token ${this.token}` }),
      });

      this.logger?.debug(`Response: ${response.status} ${response.statusText}`);
      this.logger?.debug(`Response body: ${JSON.stringify(response.data).slice(0, 2000)}`);

      return response;
    };
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
