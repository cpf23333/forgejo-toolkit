export interface ForgejoInstance {
  id: string;
  url: string;
  token: string;
  name: string;
  username: string;
}

export type HostToWebviewMessage =
  | { command: 'instances'; data: ForgejoInstance[] }
  | {
      command: 'initialState';
      instances: ForgejoInstance[];
      locale: 'en' | 'zh';
      debug: boolean;
      worktrees: unknown[];
      worktreeOpenMode: 'ask' | 'currentWindow' | 'newWindow';
      worktreeCacheDirectory: string;
      worktreeCacheDirectoryDefault: string;
    }
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
      command: 'issueCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
    }
  | {
      command: 'issueUpdated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
    }
  | {
      command: 'issueAttachmentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      uuid?: string;
      name?: string;
      size?: number;
      browser_download_url?: string;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'pullRequestCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
    }
  | {
      command: 'pullRequestUpdated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
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
  | {
      command: 'repoContents';
      instanceId: string;
      owner: string;
      repo: string;
      ref: string;
      path: string;
      entries?: unknown[];
      error?: string;
    }
  | {
      command: 'repoFilesSearchResult';
      instanceId: string;
      owner: string;
      repo: string;
      ref: string;
      query: string;
      files?: unknown[];
      error?: string;
    }
  | {
      command: 'fileHistory';
      instanceId: string;
      owner: string;
      repo: string;
      path: string;
      ref: string;
      commits?: unknown[];
      error?: string;
    }
  | {
      command: 'repoRefs';
      instanceId: string;
      owner: string;
      repo: string;
      branches?: unknown[];
      tags?: unknown[];
      releases?: unknown[];
      error?: string;
    }
  | {
      command: 'repoBranchCreated';
      instanceId: string;
      owner: string;
      repo: string;
      branch?: string;
      error?: string;
    }
  | {
      command: 'repoBranchDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      branch?: string;
      error?: string;
    }
  | {
      command: 'repoTagCreated';
      instanceId: string;
      owner: string;
      repo: string;
      tag?: string;
      error?: string;
    }
  | {
      command: 'repoTagDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      tag?: string;
      error?: string;
    }
  | {
      command: 'repoReleaseCreated';
      instanceId: string;
      owner: string;
      repo: string;
      release?: string;
      error?: string;
    }
  | {
      command: 'repoReleaseDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      release?: string;
      error?: string;
    }
  | {
      command: 'repoReleaseEdited';
      instanceId: string;
      owner: string;
      repo: string;
      release?: string;
      error?: string;
    }
  | {
      command: 'releaseAttachmentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      attachment?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'releaseAttachmentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      attachmentId: number;
      error?: string;
      _requestId: string;
    }
  | { command: 'showInputBoxResult'; id: string; value?: string; cancelled: boolean }
  | { command: 'showConfirmResult'; id: string; confirmed: boolean }
  | { command: 'worktreesList'; worktrees: unknown[] }
  | { command: 'worktreeOpened'; worktree: unknown; existed?: boolean }
  | { command: 'worktreeCancelled'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'worktreeRemoved'; id: string }
  | { command: 'worktreeError'; error: string }
  | {
      command: 'issueAttachmentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      attachmentId: number;
      error?: string;
      _requestId: string;
    }
  | { command: 'worktreeOpenMode'; mode: 'ask' | 'currentWindow' | 'newWindow' }
  | { command: 'worktreeCacheDirectory'; directory: string; defaultDirectory: string }
  | { command: 'testConnectionResult'; success: boolean; username?: string; error?: string }
  | { command: 'saveInstanceResult'; success: boolean; error?: string };

export type WebviewToHostMessage =
  | { command: 'getInitialState' }
  | { command: 'testConnection'; url: string; token: string }
  | { command: 'saveInstance'; url: string; token: string }
  | { command: 'editInstance'; id: string; url: string; token: string }
  | { command: 'removeInstance'; id: string }
  | {
      command: 'deleteIssueAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      attachmentId: number;
      _requestId: string;
    }
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
      command: 'createIssue';
      instanceId: string;
      owner: string;
      repo: string;
      data: { title: string; body: string };
    }
  | {
      command: 'editIssue';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      data: { title?: string; body?: string; state?: 'open' | 'closed' };
    }
  | {
      command: 'createIssueAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      name: string;
      data: number[];
      _requestId: string;
    }
  | {
      command: 'createPullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      data: { title: string; body: string; base?: string; head?: string };
    }
  | {
      command: 'editPullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      data: { title?: string; body?: string; state?: 'open' | 'closed' };
    }
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
  | { command: 'getRepoContents'; instanceId: string; owner: string; repo: string; path: string; ref: string }
  | { command: 'openRepoFile'; instanceId: string; owner: string; repo: string; path: string; ref: string }
  | {
      command: 'searchRepoFiles';
      instanceId: string;
      owner: string;
      repo: string;
      ref: string;
      query: string;
    }
  | {
      command: 'getFileHistory';
      instanceId: string;
      owner: string;
      repo: string;
      path: string;
      ref: string;
    }
  | {
      command: 'openRepoFileDiff';
      instanceId: string;
      owner: string;
      repo: string;
      path: string;
      baseRef: string;
      headRef: string;
    }
  | { command: 'getRepoRefs'; instanceId: string; owner: string; repo: string }
  | {
      command: 'createRepoBranch';
      instanceId: string;
      owner: string;
      repo: string;
      newBranchName: string;
      oldRefName?: string;
    }
  | { command: 'deleteRepoBranch'; instanceId: string; owner: string; repo: string; branch: string }
  | {
      command: 'createRepoTag';
      instanceId: string;
      owner: string;
      repo: string;
      tagName: string;
      target?: string;
      message?: string;
    }
  | { command: 'deleteRepoTag'; instanceId: string; owner: string; repo: string; tag: string }
  | {
      command: 'createRepoRelease';
      instanceId: string;
      owner: string;
      repo: string;
      tagName: string;
      name?: string;
      body?: string;
      targetCommitish?: string;
      prerelease?: boolean;
      draft?: boolean;
      hideArchiveLinks?: boolean;
    }
  | { command: 'deleteRepoRelease'; instanceId: string; owner: string; repo: string; id: number }
  | {
      command: 'createReleaseAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      name: string;
      data: number[];
      _requestId: string;
    }
  | {
      command: 'deleteReleaseAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      attachmentId: number;
      _requestId: string;
    }
  | {
      command: 'editRepoRelease';
      instanceId: string;
      owner: string;
      repo: string;
      id: number;
      data: {
        tag_name?: string;
        name?: string;
        body?: string;
        target_commitish?: string;
        prerelease?: boolean;
        draft?: boolean;
        hide_archive_links?: boolean;
      };
    }
  | { command: 'showInputBox'; id: string; prompt: string; value?: string; placeHolder?: string }
  | { command: 'showConfirm'; id: string; message: string }
  | { command: 'copyToClipboard'; text: string }
  | { command: 'openExternal'; url: string }
  | { command: 'previewReadme'; owner: string; repo: string; content: string }
  | { command: 'openPrWorktree'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'removeWorktree'; id: string }
  | { command: 'setWorktreeOpenMode'; mode: 'ask' | 'currentWindow' | 'newWindow' }
  | { command: 'setWorktreeCacheDirectory'; directory: string }
  | { command: 'browseWorktreeCacheDirectory' }
  | { command: 'openOnboardingPanel' }
  | { command: 'closeOnboarding' };
