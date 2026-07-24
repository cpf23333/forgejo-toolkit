export interface ForgejoInstance {
  id: string;
  url: string;
  token: string;
  name: string;
  username: string;
}

export type HostToWebviewMessage =
  | { command: 'instances'; data: ForgejoInstance[] }
  | { command: 'openSettings' }
  | { command: 'openDashboard' }
  | { command: 'setLocale'; locale: 'en' | 'zh' }
  | { command: 'setDebug'; debug: boolean }
  | { command: 'repositories'; instanceId: string; repositories?: unknown[]; error?: string }
  | { command: 'myIssues'; instanceId: string; issues?: unknown[]; error?: string }
  | { command: 'myPullRequests'; instanceId: string; pullRequests?: unknown[]; error?: string }
  | { command: 'repoDetail'; instanceId: string; owner: string; repo: string; detail?: unknown; error?: string }
  | {
      command: 'repoBranchCommits';
      instanceId: string;
      owner: string;
      repo: string;
      branch: string;
      commits?: unknown[];
      error?: string;
    }
  | {
      command: 'issueDetail';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      detail?: unknown;
      error?: string;
    }
  | {
      command: 'pullRequestDetail';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      detail?: unknown;
      error?: string;
    }
  | {
      command: 'pullRequestFiles';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      files?: unknown[];
      error?: string;
    }
  | {
      command: 'pullRequestCommentsAndTimeline';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      comments?: unknown[];
      error?: string;
    }
  | {
      command: 'pullRequestCommits';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      commits?: unknown[];
      error?: string;
    }
  | {
      command: 'repoIssues';
      instanceId: string;
      owner: string;
      repo: string;
      state: string;
      issues?: unknown[];
      error?: string;
    }
  | {
      command: 'repoPullRequests';
      instanceId: string;
      owner: string;
      repo: string;
      state: string;
      pullRequests?: unknown[];
      error?: string;
    }
  | { command: 'renderedMarkdown'; key: string; html?: string; error?: string }
  | { command: 'worktreesList'; worktrees: unknown[] }
  | { command: 'worktreeOpened'; worktree: unknown; existed?: boolean }
  | { command: 'worktreeRemoved'; id: string }
  | { command: 'worktreeError'; error: string }
  | { command: 'worktreeOpenMode'; mode: 'currentWindow' | 'newWindow' }
  | { command: 'worktreeCacheDirectory'; directory: string; defaultDirectory: string }
  | { command: 'testConnectionResult'; success: boolean; username?: string; error?: string }
  | { command: 'saveInstanceResult'; success: boolean; error?: string };

export type WebviewToHostMessage =
  | { command: 'getInstances' }
  | { command: 'getLocale' }
  | { command: 'testConnection'; url: string; token: string }
  | { command: 'saveInstance'; url: string; token: string }
  | { command: 'removeInstance'; id: string }
  | { command: 'setLocale'; locale: string }
  | { command: 'setDebug'; debug: boolean }
  | { command: 'getRepositories'; instanceId: string }
  | { command: 'getMyIssues'; instanceId: string; state?: string }
  | { command: 'getMyPullRequests'; instanceId: string; state?: string }
  | { command: 'getRepoDetail'; instanceId: string; owner: string; repo: string }
  | {
      command: 'getRepoBranchCommits';
      instanceId: string;
      owner: string;
      repo: string;
      branch: string;
    }
  | { command: 'getIssueDetail'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'getPullRequestDetail'; instanceId: string; owner: string; repo: string; index: number }
  | {
      command: 'getPullRequestFiles';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      baseSha?: string;
      headSha?: string;
    }
  | {
      command: 'getPullRequestCommentsAndTimeline';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'getPullRequestCommits';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'openPullRequestDiff';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      filename: string;
      status: string;
      baseSha: string;
      headSha: string;
    }
  | {
      command: 'openSelectedPullRequestDiffs';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      files: { filename: string; status: string }[];
      baseSha: string;
      headSha: string;
    }
  | { command: 'getRepoIssues'; instanceId: string; owner: string; repo: string; state?: string }
  | { command: 'getRepoPullRequests'; instanceId: string; owner: string; repo: string; state?: string }
  | { command: 'renderMarkdown'; instanceId: string; text: string; context?: string; key: string }
  | { command: 'copyToClipboard'; text: string }
  | { command: 'openExternal'; url: string }
  | { command: 'previewReadme'; owner: string; repo: string; content: string }
  | { command: 'openPrWorktree'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'getWorktrees' }
  | { command: 'removeWorktree'; id: string }
  | { command: 'getWorktreeOpenMode' }
  | { command: 'setWorktreeOpenMode'; mode: 'currentWindow' | 'newWindow' }
  | { command: 'getWorktreeCacheDirectory' }
  | { command: 'setWorktreeCacheDirectory'; directory: string }
  | { command: 'browseWorktreeCacheDirectory' }
  | { command: 'openOnboardingPanel' }
  | { command: 'closeOnboarding' };
