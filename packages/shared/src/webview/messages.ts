export interface ForgejoInstance {
  id: string;
  url: string;
  token: string;
  name: string;
  username: string;
  syncApiUrlsToInstanceUrl?: boolean;
}

/**
 * Instance data as exposed to webviews. The access token never leaves the
 * extension host: every API call is proxied through host message handlers,
 * so webviews only receive the non-sensitive fields.
 */
export type PublicForgejoInstance = Omit<ForgejoInstance, 'token'>;

export function toPublicInstance(instance: ForgejoInstance): PublicForgejoInstance {
  return {
    id: instance.id,
    url: instance.url,
    name: instance.name,
    username: instance.username,
    ...(instance.syncApiUrlsToInstanceUrl !== undefined
      ? { syncApiUrlsToInstanceUrl: instance.syncApiUrlsToInstanceUrl }
      : {}),
  };
}

export interface ExportSettings {
  locale?: string;
  debug?: boolean;
  worktreeOpenMode?: 'ask' | 'currentWindow' | 'newWindow';
  worktreeCacheDirectory?: string;
}

export interface LinkedRepository {
  instanceId: string;
  owner: string;
  repo: string;
  localPath: string;
  remoteUrl: string;
}

/** Events accepted by the Forgejo API when submitting a pending pull review. */
export type PullReviewSubmitEvent = 'COMMENT' | 'APPROVED' | 'REQUEST_CHANGES';

export type HostToWebviewMessage =
  | { command: 'instances'; data: PublicForgejoInstance[] }
  // Sent by the "refresh instances" command: the webview should drop its
  // instance-level TTL caches and reload the dashboard lists.
  | { command: 'refreshData' }
  | {
      command: 'initialState';
      instances: PublicForgejoInstance[];
      locale: 'en' | 'zh';
      debug: boolean;
      worktrees: unknown[];
      worktreeOpenMode: 'ask' | 'currentWindow' | 'newWindow';
      worktreeCacheDirectory: string;
      worktreeCacheDirectoryDefault: string;
    }
  | { command: 'openSettings' }
  | { command: 'openDashboard' }
  | { command: 'openNotifications' }
  // Fallback reply for any request/response message whose handler finished
  // (or threw) without sending its specific reply.
  | { command: 'requestError'; _requestId: string; error: string }
  | { command: 'openCreatePullRequest'; instanceId: string; owner: string; repo: string; head: string }
  | { command: 'openNewIssue'; instanceId: string; owner: string; repo: string; title?: string; body?: string }
  | { command: 'openPullRequestDetail'; instanceId: string; owner: string; repo: string; index: number }
  | {
      command: 'startWorkResult';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      cancelled?: boolean;
      error?: string;
    }
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
      _requestId: string;
    }
  | {
      command: 'issueUpdated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
      /** Echoed from editIssue: this was a close/reopen toggle, not a form edit. */
      stateToggle?: boolean;
      /** Echoed from editIssue: this was an inline due-date save, not a form edit. */
      dueDateUpdate?: boolean;
    }
  | {
      command: 'issueDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      error?: string;
    }
  | {
      command: 'issueCommentCreated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      comment?: unknown;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'issueCommentEdited';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      comment?: unknown;
      error?: string;
    }
  | {
      command: 'issueCommentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      error?: string;
    }
  | {
      command: 'issueCommentAttachmentDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      attachmentId: number;
      error?: string;
      _requestId: string;
    }
  | {
      command: 'issueCommentAttachmentCreated';
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
    }
  | {
      command: 'pullRequestReviewSubmitted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'pullRequestMerged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      error?: string;
    }
  | {
      command: 'revertMergeCommitResult';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      success?: boolean;
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
      _requestId: string;
    }
  | {
      command: 'pullRequestUpdated';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: unknown;
      error?: string;
      /** Echoed from editPullRequest: this was a close/reopen toggle, not a form edit. */
      stateToggle?: boolean;
      /** Echoed from editPullRequest: this was an inline due-date save, not a form edit. */
      dueDateUpdate?: boolean;
    }
  | {
      command: 'pullRequestFiles';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      baseSha?: string;
      headSha?: string;
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
      query?: string;
      issues?: unknown[];
      error?: string;
    }
  | {
      command: 'repoPullRequests';
      instanceId: string;
      owner: string;
      repo: string;
      state: string;
      query?: string;
      pullRequests?: unknown[];
      error?: string;
    }
  | {
      command: 'actionRuns';
      instanceId: string;
      owner: string;
      repo: string;
      page: number;
      actionRuns?: unknown[];
      totalCount?: number;
      error?: string;
    }
  | {
      command: 'actionRun';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      run?: unknown;
      error?: string;
    }
  | {
      command: 'actionRunJobs';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      jobs?: unknown[];
      error?: string;
    }
  | {
      command: 'actionRunArtifacts';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      artifacts?: unknown[];
      error?: string;
    }
  | {
      command: 'actionJobLog';
      instanceId: string;
      owner: string;
      repo: string;
      jobId: number;
      log?: string;
      error?: string;
    }
  | {
      command: 'actionRunDispatched';
      instanceId: string;
      owner: string;
      repo: string;
      workflowfilename: string;
      accepted?: boolean;
      run?: unknown;
      error?: string;
    }
  | {
      command: 'actionRunCancelled';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      success?: boolean;
      error?: string;
    }
  | {
      command: 'actionArtifactDownloaded';
      instanceId: string;
      owner: string;
      repo: string;
      artifactId: number;
      path?: string;
      cancelled?: boolean;
      error?: string;
    }
  | {
      command: 'actionRunDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
      success?: boolean;
      error?: string;
    }
  | {
      command: 'repoLabels';
      instanceId: string;
      owner: string;
      repo: string;
      labels?: unknown[];
      error?: string;
    }
  | {
      command: 'repoAssignees';
      instanceId: string;
      owner: string;
      repo: string;
      assignees?: string[];
      error?: string;
    }
  | {
      command: 'repoMilestones';
      instanceId: string;
      owner: string;
      repo: string;
      milestones?: unknown[];
      error?: string;
    }
  | { command: 'renderedMarkdown'; _requestId: string; html?: string; error?: string }
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
      item?: unknown;
      error?: string;
      _requestId: string;
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
  | {
      command: 'worktreeError';
      error: string;
      /** Which operation failed, so the webview can route the error to the right view. */
      operation?: 'open' | 'remove';
      instanceId?: string;
      owner?: string;
      repo?: string;
      index?: number;
    }
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
  | { command: 'saveInstanceResult'; success: boolean; error?: string }
  | { command: 'linkedRepository'; linked?: LinkedRepository; all?: LinkedRepository[] }
  | {
      command: 'globalSearchResult';
      instanceId: string;
      scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
      query: string;
      state: string;
      repositories?: unknown[];
      issues?: unknown[];
      pullRequests?: unknown[];
      error?: string;
    }
  | {
      command: 'notifications';
      instanceId: string;
      notifications?: unknown[];
      error?: string;
    }
  | {
      /** Poller pushes land in a separate slot from the user's filtered view. */
      command: 'polledNotifications';
      instanceId: string;
      notifications?: unknown[];
      /** Set when the poll itself failed (e.g. invalid token, instance down). */
      error?: string;
    }
  | {
      command: 'notificationMarkedRead';
      instanceId: string;
      id: number;
      error?: string;
    }
  | {
      command: 'allNotificationsMarkedRead';
      instanceId: string;
      error?: string;
    }
  | {
      command: 'instancesExported';
      success: boolean;
      path?: string;
      error?: string;
    }
  | {
      command: 'instancesImported';
      success: boolean;
      count?: number;
      error?: string;
    }
  | {
      command: 'importInstancesPreview';
      instances: ForgejoInstance[];
      existingIds: string[];
      /** Parallel to `instances`: true when the token collides with a different existing instance. Computed host-side so stored tokens are never sent to the webview. */
      tokenConflicts?: boolean[];
      settings?: ExportSettings;
      error?: string;
      /** True when the user dismissed the file picker; the webview frees its pending slot without navigating. */
      cancelled?: boolean;
    }
  | {
      command: 'issueSubscriptionChecked';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      subscribed?: boolean;
      error?: string;
    }
  | {
      command: 'issueSubscriptionChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      subscribed?: boolean;
      error?: string;
    }
  | {
      command: 'issueStopwatchChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      action: 'start' | 'stop' | 'delete';
      error?: string;
    }
  | {
      command: 'userStopwatches';
      instanceId: string;
      stopwatches?: unknown[];
      error?: string;
    }
  | {
      command: 'issueTrackedTimes';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      times?: unknown[];
      error?: string;
    }
  | {
      command: 'issueTimeAdded';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      time?: unknown;
      error?: string;
    }
  | {
      command: 'issueTimeReset';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      error?: string;
    }
  | {
      command: 'issueTimeDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      id: number;
      error?: string;
    }
  | {
      command: 'issueDependencies';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencies?: unknown[];
      error?: string;
    }
  | {
      command: 'issueDependencyChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencyIndex: number;
      action: 'add' | 'remove';
      error?: string;
    }
  | {
      command: 'issueReactions';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reactions?: unknown[];
      error?: string;
    }
  | {
      command: 'issueReactionChanged';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      content: string;
      action: 'add' | 'remove';
      error?: string;
    }
  | {
      command: 'commentReactions';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      reactions?: unknown[];
      error?: string;
    }
  | {
      command: 'commentReactionChanged';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      content: string;
      action: 'add' | 'remove';
      error?: string;
    }
  | {
      command: 'mentionSearchResult';
      _requestId: string;
      users?: unknown[];
      issues?: unknown[];
      error?: string;
    }
  | {
      command: 'userPreviewResult';
      _requestId: string;
      user?: unknown;
      error?: string;
    }
  | {
      command: 'issuePreviewResult';
      _requestId: string;
      issue?: unknown;
      error?: string;
    }
  | {
      command: 'openPullReviewCommentEditor';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      path: string;
      position: number;
      isBase: boolean;
      lineNumber: number;
      /** Additional lines after `lineNumber` for multi-line comments (0/undefined = single line). */
      extraLinesCount?: number;
      mode: 'single' | 'review';
      pendingReviewId?: number;
    }
  | {
      // The panel is a singleton: before reusing it for a different line/PR
      // the host asks whether the current editor holds an unsubmitted draft.
      command: 'queryPullReviewCommentDraft';
    }
  | {
      command: 'pullReviewCommentSubmitted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reviewId?: number;
      error?: string;
    }
  | {
      command: 'pullReviewSubmitted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      error?: string;
    }
  | {
      command: 'pullReviewDeleted';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      /** True when the user declined the confirmation dialog; the review still exists. */
      cancelled?: boolean;
      error?: string;
    };

export type WebviewToHostMessage =
  | { command: 'getInitialState' }
  | { command: 'getLinkedRepository' }
  | { command: 'testConnection'; url: string; token: string; instanceId?: string }
  | { command: 'saveInstance'; url: string; token: string; syncApiUrlsToInstanceUrl?: boolean }
  | { command: 'editInstance'; id: string; url: string; token: string; syncApiUrlsToInstanceUrl?: boolean }
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
      data: {
        title: string;
        body: string;
        ref?: string;
        labels?: number[];
        assignees?: string[];
        milestone?: number;
        due_date?: string;
      };
      _requestId: string;
    }
  | {
      command: 'editIssue';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      data: {
        title?: string;
        body?: string;
        state?: 'open' | 'closed';
        labels?: number[];
        assignees?: string[];
        milestone?: number;
        due_date?: string;
        unset_due_date?: boolean;
        /** Marks a close/reopen toggle: stripped before the API call, echoed as stateToggle. */
        state_toggle?: boolean;
        /** Marks an inline due-date save: stripped before the API call, echoed as dueDateUpdate. */
        due_date_update?: boolean;
      };
    }
  | {
      command: 'deleteIssue';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'createIssueComment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      body: string;
      _requestId: string;
    }
  | {
      command: 'editIssueComment';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      body: string;
    }
  | {
      command: 'deleteIssueComment';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
    }
  | {
      command: 'deleteIssueCommentAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      attachmentId: number;
      _requestId: string;
    }
  | {
      command: 'createIssueCommentAttachment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      commentId: number;
      name: string;
      data: number[];
      _requestId: string;
    }
  | {
      command: 'mergePullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      strategy: 'merge' | 'rebase' | 'squash';
    }
  | {
      command: 'revertMergeCommit';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
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
      data: {
        title: string;
        body: string;
        base?: string;
        head?: string;
        assignees?: string[];
        labels?: number[];
        milestone?: number;
        due_date?: string;
      };
      _requestId: string;
    }
  | {
      command: 'editPullRequest';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      data: {
        title?: string;
        body?: string;
        state?: 'open' | 'closed';
        base?: string;
        assignees?: string[];
        labels?: number[];
        milestone?: number;
        due_date?: string;
        unset_due_date?: boolean;
        /** Marks a close/reopen toggle: stripped before the API call, echoed as stateToggle. */
        state_toggle?: boolean;
        /** Marks an inline due-date save: stripped before the API call, echoed as dueDateUpdate. */
        due_date_update?: boolean;
      };
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
      /** Old path of a renamed file; the base side must be fetched under it. */
      previousFilename?: string;
      baseSha: string;
      headSha: string;
    }
  | {
      command: 'openSelectedPullRequestDiffs';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      files: { filename: string; status: string; previous_filename?: string }[];
      baseSha: string;
      headSha: string;
    }
  | { command: 'getRepoIssues'; instanceId: string; owner: string; repo: string; state?: string; query?: string }
  | { command: 'getRepoPullRequests'; instanceId: string; owner: string; repo: string; state?: string; query?: string }
  | { command: 'getActionRuns'; instanceId: string; owner: string; repo: string; page?: number; limit?: number }
  | { command: 'getActionRun'; instanceId: string; owner: string; repo: string; runId: number }
  | { command: 'getActionRunJobs'; instanceId: string; owner: string; repo: string; runId: number }
  | { command: 'getActionRunArtifacts'; instanceId: string; owner: string; repo: string; runId: number }
  | { command: 'getActionJobLog'; instanceId: string; owner: string; repo: string; jobId: number }
  | {
      command: 'dispatchWorkflow';
      instanceId: string;
      owner: string;
      repo: string;
      workflowfilename: string;
      ref: string;
      inputs?: Record<string, string>;
    }
  | {
      command: 'cancelActionRun';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
    }
  | {
      command: 'deleteActionRun';
      instanceId: string;
      owner: string;
      repo: string;
      runId: number;
    }
  | {
      command: 'downloadActionArtifact';
      instanceId: string;
      owner: string;
      repo: string;
      artifactId: number;
      name: string;
    }
  | { command: 'getRepoLabels'; instanceId: string; owner: string; repo: string }
  | { command: 'getRepoAssignees'; instanceId: string; owner: string; repo: string }
  | { command: 'getRepoMilestones'; instanceId: string; owner: string; repo: string }
  | { command: 'renderMarkdown'; instanceId: string; text: string; context?: string; _requestId: string }
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
      _requestId: string;
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
  | { command: 'showConfirm'; id: string; message: string; confirmLabel: string }
  | { command: 'copyToClipboard'; text: string }
  | { command: 'openExternal'; url: string }
  // Opens a recorded worktree path in the OS file manager. The host validates
  // the path against the known worktree list instead of trusting a URI.
  | { command: 'openWorktreePath'; path: string }
  | { command: 'previewReadme'; owner: string; repo: string; content: string }
  | { command: 'openPrWorktree'; instanceId: string; owner: string; repo: string; index: number }
  | { command: 'startWorkOnIssue'; instanceId: string; owner: string; repo: string; index: number; title?: string }
  | { command: 'removeWorktree'; id: string }
  | { command: 'setWorktreeOpenMode'; mode: 'ask' | 'currentWindow' | 'newWindow' }
  | { command: 'setWorktreeCacheDirectory'; directory: string }
  | { command: 'browseWorktreeCacheDirectory' }
  | { command: 'openOnboardingPanel' }
  | { command: 'closeOnboarding' }
  | {
      command: 'globalSearch';
      instanceId: string;
      scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
      query: string;
      state: string;
      limit?: number;
    }
  | {
      command: 'getNotifications';
      instanceId: string;
      statusTypes?: string[];
      subjectType?: string[];
      limit?: number;
    }
  | {
      command: 'markNotificationRead';
      instanceId: string;
      id: number;
    }
  | {
      command: 'markAllNotificationsRead';
      instanceId: string;
    }
  | { command: 'exportInstances'; ids?: string[] }
  | { command: 'copyInstancesToClipboard'; ids?: string[] }
  | { command: 'previewImportInstances' }
  | {
      command: 'importInstances';
      instances?: ForgejoInstance[];
      settings?: ExportSettings;
    }
  | {
      command: 'checkIssueSubscription';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'changeIssueSubscription';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      user: string;
      subscribe: boolean;
    }
  | {
      command: 'startIssueStopwatch';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'stopIssueStopwatch';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'deleteIssueStopwatch';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'getUserStopwatches';
      instanceId: string;
    }
  | {
      command: 'getIssueTrackedTimes';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'addIssueTime';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      time: number;
    }
  | {
      command: 'resetIssueTime';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'deleteIssueTime';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      id: number;
    }
  | {
      command: 'getIssueDependencies';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'createIssueDependency';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencyIndex: number;
    }
  | {
      command: 'removeIssueDependency';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      dependencyIndex: number;
    }
  | {
      command: 'getIssueReactions';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
    }
  | {
      command: 'changeIssueReaction';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      content: string;
      add: boolean;
    }
  | {
      command: 'getCommentReactions';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
    }
  | {
      command: 'changeCommentReaction';
      instanceId: string;
      owner: string;
      repo: string;
      commentId: number;
      content: string;
      add: boolean;
    }
  | {
      command: 'searchMentions';
      instanceId: string;
      owner: string;
      repo: string;
      query: string;
      type: 'user' | 'issue' | 'all';
      _requestId: string;
    }
  | {
      command: 'getUserPreview';
      instanceId: string;
      username: string;
      _requestId: string;
    }
  | {
      command: 'getIssuePreview';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      _requestId: string;
    }
  | {
      command: 'submitPullReviewComment';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      path: string;
      position: number;
      isBase: boolean;
      body: string;
      mode: 'single' | 'review';
      pendingReviewId?: number;
    }
  | {
      command: 'submitPullReview';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reviewId: number;
      event?: PullReviewSubmitEvent;
      body?: string;
    }
  | {
      command: 'deletePullReview';
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      reviewId: number;
    }
  | {
      command: 'pullReviewCommentDraftState';
      dirty: boolean;
    }
  | { command: 'closePullReviewCommentPanel' };
