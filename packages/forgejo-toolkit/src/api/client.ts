import { client as baseClient } from '@cpf23333-forgejo-toolkit/shared/request';
import type { Client, RequestConfig, ResponseConfig } from '@cpf23333-forgejo-toolkit/shared/request';
import {
  issueGetIssue,
  issueSearchIssues,
  repoGet,
  repoGetAllCommits,
  repoGetContents,
  repoGetPullRequest,
  repoListBranches,
  userCurrentListRepos,
  userGetCurrent,
} from '@cpf23333-forgejo-toolkit/api';
import type { Logger } from '../logger';
import type {
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

  getPullRequestDetail(owner: string, repo: string, index: number): Promise<ForgejoPullRequestDetail> {
    return repoGetPullRequest(owner, repo, index, { client: this._client() }) as Promise<ForgejoPullRequestDetail>;
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
