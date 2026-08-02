import { ref, reactive, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ForgejoInstance } from '../types/instance';

const loading = reactive(new Map<string, boolean>());
const errors = reactive(new Map<string, string>());
import '../types/config';
import { vscode } from './vscode';

const vscodeVersion = window.__FORGEJO_TOOLKIT_CONFIG__?.vscodeVersion ?? '';
import type { Locale } from '../i18n';
import type {
  ForgejoChangedFile,
  ForgejoCommit,
  ForgejoRepository,
  ForgejoIssue,
  ForgejoPullRequest,
  ForgejoRepoDetail,
  ForgejoIssueDetail,
  ForgejoIssueAttachment,
  ForgejoPullRequestDetail,
  ForgejoPullRequestWorktreeInfo,
  ForgejoTimelineComment,
  ForgejoPullRequestCommit,
  ForgejoContentEntry,
  ForgejoBranch,
  ForgejoTag,
  ForgejoRelease,
  ForgejoReleaseAttachment,
} from '../types/api';
import type { GitEntry } from '@cpf23333-forgejo-toolkit/api';

import type { HostToWebviewMessage } from '@cpf23333-forgejo-toolkit/shared/webview/messages';

function createAppState() {
  const router = useRouter();
  const { t, locale } = useI18n();

  const instances = ref<ForgejoInstance[]>([]);

  const repositories = ref<Map<string, ForgejoRepository[]>>(new Map());
  const myIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const myPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  const repoDetails = ref<Map<string, ForgejoRepoDetail>>(new Map());
  const issueDetails = ref<Map<string, ForgejoIssueDetail>>(new Map());
  const pullRequestDetails = ref<Map<string, ForgejoPullRequestDetail>>(new Map());
  const repoIssues = ref<Map<string, ForgejoIssue[]>>(new Map());
  const repoPullRequests = ref<Map<string, ForgejoPullRequest[]>>(new Map());
  const repoBranchCommits = ref<Map<string, ForgejoCommit[]>>(new Map());
  const pullRequestFiles = ref<Map<string, ForgejoChangedFile[]>>(new Map());
  const pullRequestComments = ref<Map<string, ForgejoTimelineComment[]>>(new Map());
  const pullRequestCommits = ref<Map<string, ForgejoPullRequestCommit[]>>(new Map());
  const repoContents = ref<Map<string, ForgejoContentEntry[]>>(new Map());
  const repoRefs = ref<Map<string, { branches: ForgejoBranch[]; tags: ForgejoTag[]; releases: ForgejoRelease[] }>>(
    new Map(),
  );
  const repoFileSearchResults = ref<Map<string, GitEntry[]>>(new Map());
  const fileHistories = ref<Map<string, ForgejoCommit[]>>(new Map());
  const renderedMarkdown = ref<Map<string, string>>(new Map());

  let inputRequestId = 0;
  const inputBoxPromises = new Map<string, (value: string | undefined) => void>();
  const confirmPromises = new Map<string, (value: boolean) => void>();
  const releaseAttachmentPromises = new Map<
    string,
    { resolve: (value: ForgejoReleaseAttachment) => void; reject: (error: string) => void }
  >();
  const releaseAttachmentDeletePromises = new Map<string, { resolve: () => void; reject: (error: string) => void }>();

  const debug = ref<boolean>(false);
  const worktrees = ref<ForgejoPullRequestWorktreeInfo[]>([]);
  const worktreeOpenMode = ref<'ask' | 'currentWindow' | 'newWindow'>('ask');
  const worktreeCacheDirectory = ref<string | undefined>(undefined);
  const worktreeCacheDirectoryDefault = ref<string | undefined>(undefined);
  const supportsMultiDiff = computed(() => isVersionAtLeast(vscodeVersion, '1.86.0'));
  const dashboardActiveTab = ref<'repositories' | 'issues' | 'pullRequests'>('repositories');
  const testConnectionResult = ref<{ success: boolean; username?: string; error?: string } | undefined>(undefined);
  const saveInstanceResult = ref<{ success: boolean; error?: string } | undefined>(undefined);
  const lastSavedIssue = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(undefined);
  const lastSavedPullRequest = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(
    undefined,
  );
  const lastWorktreeCancelled = ref<{ instanceId: string; owner: string; repo: string; index: number } | undefined>(
    undefined,
  );
  let renderMarkdownRequestId = 0;
  const pendingRenderMarkdownRequests = new Map<
    string,
    { resolve: (html: string) => void; reject: (error: Error) => void }
  >();
  let attachmentUploadRequestId = 0;
  const pendingAttachmentUploads = new Map<
    string,
    { resolve: (attachment: ForgejoIssueAttachment) => void; reject: (error: Error) => void }
  >();
  let attachmentDeleteRequestId = 0;
  const pendingAttachmentDeletes = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();

  function handleMessage(event: MessageEvent<HostToWebviewMessage>) {
    const message = event.data;
    switch (message.command) {
      case 'initialState':
        instances.value = message.instances ?? [];
        locale.value = message.locale;
        debug.value = message.debug;
        worktrees.value = (message.worktrees ?? []) as ForgejoPullRequestWorktreeInfo[];
        worktreeOpenMode.value = message.worktreeOpenMode;
        worktreeCacheDirectory.value = message.worktreeCacheDirectory;
        worktreeCacheDirectoryDefault.value = message.worktreeCacheDirectoryDefault;
        break;
      case 'instances':
        instances.value = message.data ?? [];
        break;
      case 'openSettings':
        router.push({ name: 'settings' });
        break;
      case 'openDashboard':
        router.push({ name: 'dashboard' });
        break;
      case 'setLocale':
        locale.value = message.locale;
        break;
      case 'setDebug':
        debug.value = message.debug;
        break;
      case 'repositories':
        handleRepositories(message as { instanceId: string; repositories?: ForgejoRepository[]; error?: string });
        break;
      case 'myIssues':
        handleMyIssues(message as { instanceId: string; issues?: ForgejoIssue[]; error?: string });
        break;
      case 'myPullRequests':
        handleMyPullRequests(message as { instanceId: string; pullRequests?: ForgejoPullRequest[]; error?: string });
        break;
      case 'repoDetail':
        handleRepoDetail(
          message as { instanceId: string; owner: string; repo: string; detail?: ForgejoRepoDetail; error?: string },
        );
        break;
      case 'repoBranchCommits':
        handleRepoBranchCommits(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            branch: string;
            commits?: ForgejoCommit[];
            error?: string;
          },
        );
        break;
      case 'issueDetail':
        handleIssueDetail(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            detail?: ForgejoIssueDetail;
            error?: string;
          },
        );
        break;
      case 'pullRequestDetail':
        handlePullRequestDetail(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            detail?: ForgejoPullRequestDetail;
            error?: string;
          },
        );
        break;
      case 'issueCreated':
      case 'issueUpdated':
        handleIssueSaved(
          message.command,
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            item?: ForgejoIssue;
            error?: string;
          },
        );
        break;
      case 'issueCommentCreated':
        handleIssueCommentCreated(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            comment?: ForgejoTimelineComment;
            error?: string;
          },
        );
        break;
      case 'issueCommentEdited':
        handleIssueCommentEdited(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            comment?: ForgejoTimelineComment;
            error?: string;
          },
        );
        break;
      case 'issueCommentAttachmentCreated':
        handleIssueCommentAttachmentCreated(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            commentId: number;
            uuid?: string;
            name?: string;
            size?: number;
            browser_download_url?: string;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'issueCommentDeleted':
        handleIssueCommentDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            error?: string;
          },
        );
        break;
      case 'issueCommentAttachmentDeleted':
        handleIssueCommentAttachmentDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            attachmentId: number;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'pullRequestMerged':
        handlePullRequestMerged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            error?: string;
          },
        );
        break;
      case 'issueAttachmentCreated':
        handleIssueAttachmentCreated(
          message as {
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
          },
        );
        break;
      case 'issueAttachmentDeleted':
        handleIssueAttachmentDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            attachmentId: number;
            error?: string;
            _requestId: string;
          },
        );
        break;
      case 'pullRequestCreated':
      case 'pullRequestUpdated':
        handlePullRequestSaved(
          message.command,
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            item?: ForgejoPullRequest;
            error?: string;
          },
        );
        break;
      case 'pullRequestFiles':
        handlePullRequestFiles(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            files?: ForgejoChangedFile[];
            error?: string;
          },
        );
        break;
      case 'pullRequestCommentsAndTimeline':
        handlePullRequestCommentsAndTimeline(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            comments?: ForgejoTimelineComment[];
            error?: string;
          },
        );
        break;
      case 'pullRequestCommits':
        handlePullRequestCommits(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            commits?: ForgejoPullRequestCommit[];
            error?: string;
          },
        );
        break;
      case 'repoIssues':
        handleRepoIssues(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            state: string;
            issues?: ForgejoIssue[];
            error?: string;
          },
        );
        break;
      case 'repoPullRequests':
        handleRepoPullRequests(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            state: string;
            pullRequests?: ForgejoPullRequest[];
            error?: string;
          },
        );
        break;
      case 'renderedMarkdown':
        handleRenderedMarkdown(message as { key: string; html?: string; error?: string });
        break;
      case 'repoContents':
        handleRepoContents(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            ref: string;
            path: string;
            entries?: ForgejoContentEntry[];
            error?: string;
          },
        );
        break;
      case 'repoFilesSearchResult':
        handleRepoFilesSearchResult(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            ref: string;
            query: string;
            files?: GitEntry[];
            error?: string;
          },
        );
        break;
      case 'fileHistory':
        handleFileHistory(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            path: string;
            ref: string;
            commits?: ForgejoCommit[];
            error?: string;
          },
        );
        break;
      case 'repoRefs':
        handleRepoRefs(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            branches?: ForgejoBranch[];
            tags?: ForgejoTag[];
            releases?: ForgejoRelease[];
            error?: string;
          },
        );
        break;
      case 'repoBranchCreated':
      case 'repoBranchDeleted':
      case 'repoTagCreated':
      case 'repoTagDeleted':
      case 'repoReleaseCreated':
      case 'repoReleaseEdited':
      case 'repoReleaseDeleted': {
        const { instanceId, owner, repo, error } = message as {
          instanceId: string;
          owner: string;
          repo: string;
          error?: string;
        };
        const key = repoRefsKey(instanceId, owner, repo);
        if (error) {
          errors.set(key, error);
        } else {
          errors.delete(key);
          loadRepoRefs(instanceId, owner, repo, true);
        }
        break;
      }
      case 'showInputBoxResult': {
        const { id, value } = message as { id: string; value?: string };
        const resolve = inputBoxPromises.get(id);
        if (resolve) {
          inputBoxPromises.delete(id);
          resolve(value);
        }
        break;
      }
      case 'releaseAttachmentCreated': {
        const { _requestId, attachment, error } = message as {
          _requestId: string;
          attachment?: ForgejoReleaseAttachment;
          error?: string;
        };
        const pending = releaseAttachmentPromises.get(_requestId);
        if (pending) {
          releaseAttachmentPromises.delete(_requestId);
          if (error || !attachment) {
            pending.reject(error || 'Attachment upload failed');
          } else {
            pending.resolve(attachment);
          }
        }
        break;
      }
      case 'releaseAttachmentDeleted': {
        const { _requestId, error } = message as { _requestId: string; error?: string };
        const pending = releaseAttachmentDeletePromises.get(_requestId);
        if (pending) {
          releaseAttachmentDeletePromises.delete(_requestId);
          if (error) {
            pending.reject(error);
          } else {
            pending.resolve();
          }
        }
        break;
      }
      case 'showConfirmResult': {
        const { id, confirmed } = message as { id: string; confirmed: boolean };
        const resolve = confirmPromises.get(id);
        if (resolve) {
          confirmPromises.delete(id);
          resolve(confirmed);
        }
        break;
      }
      case 'worktreesList':
        worktrees.value = (message.worktrees ?? []) as ForgejoPullRequestWorktreeInfo[];
        break;
      case 'worktreeOpened':
        if (message.worktree) {
          const wt = message.worktree as ForgejoPullRequestWorktreeInfo;
          const list = worktrees.value.filter((w) => w.id !== wt.id);
          list.push(wt);
          worktrees.value = list;
        }
        break;
      case 'worktreeRemoved':
        if (message.id) {
          worktrees.value = worktrees.value.filter((w) => w.id !== message.id);
        }
        break;
      case 'worktreeCancelled':
        lastWorktreeCancelled.value = {
          instanceId: message.instanceId,
          owner: message.owner,
          repo: message.repo,
          index: message.index,
        };
        break;
      case 'worktreeOpenMode':
        if (message.mode === 'ask' || message.mode === 'currentWindow' || message.mode === 'newWindow') {
          worktreeOpenMode.value = message.mode;
        }
        break;
      case 'worktreeCacheDirectory':
        worktreeCacheDirectory.value = message.directory;
        worktreeCacheDirectoryDefault.value = message.defaultDirectory;
        break;
      case 'testConnectionResult':
        testConnectionResult.value = message;
        break;
      case 'saveInstanceResult':
        saveInstanceResult.value = message;
        break;
    }
  }

  function handleRepositories(data: { instanceId: string; repositories?: ForgejoRepository[]; error?: string }) {
    const key = `repos-${data.instanceId}`;
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repositories.value.set(data.instanceId, data.repositories ?? []);
    }
  }

  function handleMyIssues(data: { instanceId: string; issues?: ForgejoIssue[]; error?: string }) {
    const key = `issues-${data.instanceId}`;
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      myIssues.value.set(data.instanceId, data.issues ?? []);
    }
  }

  function handleMyPullRequests(data: { instanceId: string; pullRequests?: ForgejoPullRequest[]; error?: string }) {
    const key = `pulls-${data.instanceId}`;
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      myPullRequests.value.set(data.instanceId, data.pullRequests ?? []);
    }
  }

  function handleRepoDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    detail?: ForgejoRepoDetail;
    error?: string;
  }) {
    const key = repoDetailKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else if (data.detail) {
      errors.delete(key);
      repoDetails.value.set(key, data.detail);
    }
  }

  function handleRepoBranchCommits(data: {
    instanceId: string;
    owner: string;
    repo: string;
    branch: string;
    commits?: ForgejoCommit[];
    error?: string;
  }) {
    const key = repoBranchCommitsKey(data.instanceId, data.owner, data.repo, data.branch);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoBranchCommits.value.set(key, data.commits ?? []);
    }
  }

  function handleIssueDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    detail?: ForgejoIssueDetail;
    error?: string;
  }) {
    const key = issueDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else if (data.detail) {
      errors.delete(key);
      issueDetails.value.set(key, data.detail);
    }
  }

  function handlePullRequestDetail(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    detail?: ForgejoPullRequestDetail;
    error?: string;
  }) {
    const key = pullRequestDetailKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else if (data.detail) {
      errors.delete(key);
      pullRequestDetails.value.set(key, data.detail);
    }
  }

  function handleIssueAttachmentCreated(data: {
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
  }) {
    const pending = pendingAttachmentUploads.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingAttachmentUploads.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else if (data.uuid) {
      pending.resolve({
        uuid: data.uuid,
        name: data.name ?? data.uuid,
        size: data.size,
        browser_download_url: data.browser_download_url ?? `/attachments/${data.uuid}`,
      });
    } else {
      pending.reject(new Error('Attachment upload failed'));
    }
  }

  function handleIssueAttachmentDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    attachmentId: number;
    error?: string;
    _requestId: string;
  }) {
    const pending = pendingAttachmentDeletes.get(data._requestId);
    if (!pending) {
      return;
    }
    pendingAttachmentDeletes.delete(data._requestId);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      pending.resolve();
    }
  }

  function handleIssueSaved(
    command: 'issueCreated' | 'issueUpdated',
    data: {
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: ForgejoIssue;
      error?: string;
    },
  ) {
    const formKey = issueFormKey(data.instanceId, data.owner, data.repo, command === 'issueUpdated' ? data.index : 0);
    loading.set(formKey, false);
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.item) {
      repoIssues.value.clear();
      myIssues.value.clear();
      lastSavedIssue.value = { instanceId: data.instanceId, owner: data.owner, repo: data.repo, index: data.index };
    }
  }

  function handleIssueCommentCreated(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    comment?: ForgejoTimelineComment;
    error?: string;
  }) {
    const formKey = issueCommentFormKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(formKey, false);
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.comment) {
      const commentsKey = pullRequestCommentsKey(data.instanceId, data.owner, data.repo, data.index);
      const existing = pullRequestComments.value.get(commentsKey) ?? [];
      const timelineComment: ForgejoTimelineComment = { ...data.comment, type: 'comment' };
      pullRequestComments.value.set(commentsKey, [...existing, timelineComment]);
    }
  }

  function handleIssueCommentEdited(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    comment?: ForgejoTimelineComment;
    error?: string;
  }) {
    const formKey = issueCommentEditFormKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(formKey, false);
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (!data.comment) {
      return;
    }
    for (const key of pullRequestComments.value.keys()) {
      const comments = pullRequestComments.value.get(key);
      if (!comments) {
        continue;
      }
      const index = comments.findIndex((c) => c.id === data.commentId);
      if (index !== -1) {
        comments[index] = { ...data.comment, type: 'comment', assets: comments[index].assets };
        pullRequestComments.value.set(key, [...comments]);
        break;
      }
    }
  }

  function handleIssueCommentAttachmentCreated(data: {
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
  }) {
    const promise = pendingAttachmentUploads.get(data._requestId);
    if (!promise) {
      return;
    }
    if (data.error) {
      promise.reject(new Error(data.error));
      pendingAttachmentUploads.delete(data._requestId);
      return;
    }
    const attachment: ForgejoIssueAttachment = {
      id: data.id,
      uuid: data.uuid ?? '',
      name: data.name ?? '',
      size: data.size,
      browser_download_url: data.browser_download_url ?? '',
    };
    promise.resolve(attachment);
    pendingAttachmentUploads.delete(data._requestId);

    const commentsKey = pullRequestCommentsKey(data.instanceId, data.owner, data.repo, data.index);
    const comments = pullRequestComments.value.get(commentsKey);
    if (!comments) {
      return;
    }
    const updatedComments = comments.map((comment) => {
      if (comment.id !== data.commentId) {
        return comment;
      }
      return { ...comment, assets: [...(comment.assets ?? []), attachment] };
    });
    pullRequestComments.value.set(commentsKey, updatedComments);
  }

  function handleIssueCommentAttachmentDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    attachmentId: number;
    error?: string;
    _requestId: string;
  }) {
    const promise = pendingAttachmentDeletes.get(data._requestId);
    if (!promise) {
      return;
    }
    if (data.error) {
      promise.reject(new Error(data.error));
      pendingAttachmentDeletes.delete(data._requestId);
      return;
    }
    promise.resolve();
    pendingAttachmentDeletes.delete(data._requestId);

    for (const comments of pullRequestComments.value.values()) {
      const comment = comments.find((c) => c.id === data.commentId);
      if (comment && comment.assets) {
        comment.assets = comment.assets.filter((a) => a.id !== data.attachmentId);
      }
    }
  }

  function handleIssueCommentDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    error?: string;
  }) {
    const formKey = issueCommentDeleteFormKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(formKey, false);
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    for (const [key, comments] of pullRequestComments.value.entries()) {
      const index = comments.findIndex((c) => c.id === data.commentId);
      if (index !== -1) {
        comments.splice(index, 1);
        pullRequestComments.value.set(key, [...comments]);
        break;
      }
    }
  }

  function handlePullRequestMerged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    error?: string;
  }) {
    const formKey = pullRequestMergeFormKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(formKey, false);
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    const detailKey = pullRequestDetailKey(data.instanceId, data.owner, data.repo, data.index);
    const detail = pullRequestDetails.value.get(detailKey);
    if (detail) {
      detail.state = 'closed';
      detail.merged = true;
    }
    repoPullRequests.value.clear();
    myPullRequests.value.clear();
  }

  function handlePullRequestSaved(
    command: 'pullRequestCreated' | 'pullRequestUpdated',
    data: {
      instanceId: string;
      owner: string;
      repo: string;
      index: number;
      item?: ForgejoPullRequest;
      error?: string;
    },
  ) {
    const formKey = pullRequestFormKey(
      data.instanceId,
      data.owner,
      data.repo,
      command === 'pullRequestUpdated' ? data.index : 0,
    );
    loading.set(formKey, false);
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.item) {
      repoPullRequests.value.clear();
      myPullRequests.value.clear();
      lastSavedPullRequest.value = {
        instanceId: data.instanceId,
        owner: data.owner,
        repo: data.repo,
        index: data.index,
      };
    }
  }

  function handlePullRequestFiles(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    files?: ForgejoChangedFile[];
    error?: string;
  }) {
    const key = pullRequestFilesKey(data.instanceId, data.owner, data.repo, data.index);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      pullRequestFiles.value.set(key, data.files ?? []);
    }
  }

  function handlePullRequestCommentsAndTimeline(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    comments?: ForgejoTimelineComment[];
    error?: string;
  }) {
    const key = pullRequestCommentsKey(data.instanceId, data.owner, data.repo, data.index);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      pullRequestComments.value.set(key, data.comments ?? []);
    }
  }

  function handlePullRequestCommits(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    commits?: ForgejoPullRequestCommit[];
    error?: string;
  }) {
    const key = pullRequestCommitsKey(data.instanceId, data.owner, data.repo, data.index);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      pullRequestCommits.value.set(key, data.commits ?? []);
    }
  }

  function handleRepoIssues(data: {
    instanceId: string;
    owner: string;
    repo: string;
    state: string;
    issues?: ForgejoIssue[];
    error?: string;
  }) {
    const key = repoIssuesKey(data.instanceId, data.owner, data.repo, data.state);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoIssues.value.set(key, data.issues ?? []);
    }
  }

  function handleRepoPullRequests(data: {
    instanceId: string;
    owner: string;
    repo: string;
    state: string;
    pullRequests?: ForgejoPullRequest[];
    error?: string;
  }) {
    const key = repoPullRequestsKey(data.instanceId, data.owner, data.repo, data.state);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoPullRequests.value.set(key, data.pullRequests ?? []);
    }
  }

  function handleRepoContents(data: {
    instanceId: string;
    owner: string;
    repo: string;
    ref: string;
    path: string;
    entries?: ForgejoContentEntry[];
    error?: string;
  }) {
    const key = repoContentsKey(data.instanceId, data.owner, data.repo, data.ref, data.path);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoContents.value.set(key, data.entries ?? []);
    }
  }

  function handleRepoFilesSearchResult(data: {
    instanceId: string;
    owner: string;
    repo: string;
    ref: string;
    query: string;
    files?: GitEntry[];
    error?: string;
  }) {
    const key = repoFileSearchKey(data.instanceId, data.owner, data.repo, data.ref, data.query);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoFileSearchResults.value.set(key, data.files ?? []);
    }
  }

  function handleFileHistory(data: {
    instanceId: string;
    owner: string;
    repo: string;
    path: string;
    ref: string;
    commits?: ForgejoCommit[];
    error?: string;
  }) {
    const key = fileHistoryKey(data.instanceId, data.owner, data.repo, data.path, data.ref);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      fileHistories.value.set(key, data.commits ?? []);
    }
  }

  function handleRepoRefs(data: {
    instanceId: string;
    owner: string;
    repo: string;
    branches?: ForgejoBranch[];
    tags?: ForgejoTag[];
    releases?: ForgejoRelease[];
    error?: string;
  }) {
    const key = repoRefsKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoRefs.value.set(key, {
        branches: data.branches ?? [],
        tags: data.tags ?? [],
        releases: data.releases ?? [],
      });
    }
  }

  function handleRenderedMarkdown(data: { key: string; html?: string; error?: string }) {
    const pending = pendingRenderMarkdownRequests.get(data.key);
    if (!pending) {
      return;
    }
    pendingRenderMarkdownRequests.delete(data.key);
    if (data.error) {
      pending.reject(new Error(data.error));
    } else {
      renderedMarkdown.value.set(data.key, data.html ?? '');
      pending.resolve(data.html ?? '');
    }
  }

  onMounted(() => {
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ command: 'getInitialState' });
  });

  function openExternal(url: string) {
    vscode.postMessage({ command: 'openExternal', url });
  }

  function copyToClipboard(text: string) {
    vscode.postMessage({ command: 'copyToClipboard', text });
  }

  function previewReadme(owner: string, repo: string, content: string) {
    vscode.postMessage({ command: 'previewReadme', owner, repo, content });
  }

  function testConnection(url: string, token: string) {
    vscode.postMessage({ command: 'testConnection', url, token });
  }

  function saveInstance(url: string, token: string) {
    vscode.postMessage({ command: 'saveInstance', url, token });
  }

  function editInstance(id: string, url: string, token: string) {
    vscode.postMessage({ command: 'editInstance', id, url, token });
  }

  function removeInstance(id: string) {
    vscode.postMessage({ command: 'removeInstance', id });
  }

  function changeLocale(newLocale: Locale) {
    locale.value = newLocale;
    vscode.postMessage({ command: 'setLocale', locale: newLocale });
  }

  function changeDebug(newDebug: boolean) {
    debug.value = newDebug;
    vscode.postMessage({ command: 'setDebug', debug: newDebug });
  }

  function openRepoDetail(instanceId: string, owner: string, repo: string) {
    router.push({ name: 'repoDetail', params: { instanceId, owner, repo } });
    loadRepoDetail(instanceId, owner, repo);
  }

  function loadRepoDetail(instanceId: string, owner: string, repo: string) {
    const key = repoDetailKey(instanceId, owner, repo);
    if (!repoDetails.value.has(key)) {
      loading.set(key, true);
      vscode.postMessage({ command: 'getRepoDetail', instanceId, owner, repo });
    }
  }

  function loadRepoBranchCommits(instanceId: string, owner: string, repo: string, branch: string) {
    const key = repoBranchCommitsKey(instanceId, owner, repo, branch);
    if (repoBranchCommits.value.has(key)) {
      return;
    }
    loading.set(key, true);
    vscode.postMessage({ command: 'getRepoBranchCommits', instanceId, owner, repo, branch });
  }

  function openRepoFile(instanceId: string, owner: string, repo: string, path: string, ref: string) {
    vscode.postMessage({ command: 'openRepoFile', instanceId, owner, repo, path, ref });
  }

  function openRepoFileDiff(
    instanceId: string,
    owner: string,
    repo: string,
    path: string,
    baseRef: string,
    headRef: string,
  ) {
    vscode.postMessage({ command: 'openRepoFileDiff', instanceId, owner, repo, path, baseRef, headRef });
  }

  function loadRepoContents(instanceId: string, owner: string, repo: string, path: string, ref: string, force = false) {
    const key = repoContentsKey(instanceId, owner, repo, ref, path);
    if (!force && repoContents.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'getRepoContents', instanceId, owner, repo, path, ref });
  }

  function loadRepoFileSearch(instanceId: string, owner: string, repo: string, ref: string, query: string) {
    const key = repoFileSearchKey(instanceId, owner, repo, ref, query);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'searchRepoFiles', instanceId, owner, repo, ref, query });
  }

  function loadFileHistory(instanceId: string, owner: string, repo: string, path: string, ref: string) {
    const key = fileHistoryKey(instanceId, owner, repo, path, ref);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'getFileHistory', instanceId, owner, repo, path, ref });
  }

  function loadRepoRefs(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoRefsKey(instanceId, owner, repo);
    if (!force && repoRefs.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'getRepoRefs', instanceId, owner, repo });
  }

  function createRepoBranch(
    instanceId: string,
    owner: string,
    repo: string,
    newBranchName: string,
    oldRefName?: string,
  ) {
    vscode.postMessage({ command: 'createRepoBranch', instanceId, owner, repo, newBranchName, oldRefName });
  }

  function deleteRepoBranch(instanceId: string, owner: string, repo: string, branch: string) {
    vscode.postMessage({ command: 'deleteRepoBranch', instanceId, owner, repo, branch });
  }

  function createRepoTag(
    instanceId: string,
    owner: string,
    repo: string,
    tagName: string,
    target?: string,
    message?: string,
  ) {
    vscode.postMessage({ command: 'createRepoTag', instanceId, owner, repo, tagName, target, message });
  }

  function deleteRepoTag(instanceId: string, owner: string, repo: string, tag: string) {
    vscode.postMessage({ command: 'deleteRepoTag', instanceId, owner, repo, tag });
  }

  function createRepoRelease(
    instanceId: string,
    owner: string,
    repo: string,
    tagName: string,
    name?: string,
    body?: string,
    targetCommitish?: string,
    prerelease?: boolean,
    draft?: boolean,
    hideArchiveLinks?: boolean,
  ) {
    vscode.postMessage({
      command: 'createRepoRelease',
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
    });
  }

  function editRepoRelease(
    instanceId: string,
    owner: string,
    repo: string,
    id: number,
    data: {
      tag_name?: string;
      name?: string;
      body?: string;
      target_commitish?: string;
      prerelease?: boolean;
      draft?: boolean;
      hide_archive_links?: boolean;
    },
  ) {
    vscode.postMessage({ command: 'editRepoRelease', instanceId, owner, repo, id, data });
  }

  function deleteRepoRelease(instanceId: string, owner: string, repo: string, id: number) {
    vscode.postMessage({ command: 'deleteRepoRelease', instanceId, owner, repo, id });
  }

  function uploadReleaseAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    id: number,
    name: string,
    data: Uint8Array,
  ): Promise<ForgejoReleaseAttachment> {
    const _requestId = `release-attachment-${++inputRequestId}`;
    return new Promise((resolve, reject) => {
      releaseAttachmentPromises.set(_requestId, { resolve, reject });
      vscode.postMessage({
        command: 'createReleaseAttachment',
        instanceId,
        owner,
        repo,
        id,
        name,
        data: Array.from(data),
        _requestId,
      });
    });
  }

  function deleteReleaseAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    id: number,
    attachmentId: number,
  ): Promise<void> {
    const _requestId = `release-attachment-delete-${++inputRequestId}`;
    return new Promise((resolve, reject) => {
      releaseAttachmentDeletePromises.set(_requestId, { resolve, reject });
      vscode.postMessage({
        command: 'deleteReleaseAttachment',
        instanceId,
        owner,
        repo,
        id,
        attachmentId,
        _requestId,
      });
    });
  }

  function showInputBox(options: {
    prompt: string;
    value?: string;
    placeHolder?: string;
  }): Promise<string | undefined> {
    const id = `input-${++inputRequestId}`;
    return new Promise((resolve) => {
      inputBoxPromises.set(id, resolve);
      vscode.postMessage({ command: 'showInputBox', id, ...options });
    });
  }

  function showConfirm(message: string): Promise<boolean> {
    const id = `confirm-${++inputRequestId}`;
    return new Promise((resolve) => {
      confirmPromises.set(id, resolve);
      vscode.postMessage({ command: 'showConfirm', id, message });
    });
  }

  function createIssue(instanceId: string, owner: string, repo: string, title: string, body: string) {
    const key = issueFormKey(instanceId, owner, repo, 0);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'createIssue', instanceId, owner, repo, data: { title, body } });
  }

  function editIssue(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: { title?: string; body?: string; state?: 'open' | 'closed' },
  ) {
    const key = issueFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'editIssue', instanceId, owner, repo, index, data });
  }

  function createIssueComment(instanceId: string, owner: string, repo: string, index: number, body: string) {
    const key = issueCommentFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'createIssueComment', instanceId, owner, repo, index, body });
  }

  function editIssueComment(instanceId: string, owner: string, repo: string, commentId: number, body: string) {
    const key = issueCommentEditFormKey(instanceId, owner, repo, commentId);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'editIssueComment', instanceId, owner, repo, commentId, body });
  }

  async function deleteIssueComment(instanceId: string, owner: string, repo: string, commentId: number) {
    const confirmed = await showConfirm(t('dashboard.detail.confirmDeleteComment'));
    if (!confirmed) {
      return;
    }
    const key = issueCommentDeleteFormKey(instanceId, owner, repo, commentId);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'deleteIssueComment', instanceId, owner, repo, commentId });
  }

  function deleteIssueCommentAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    commentId: number,
    attachmentId: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}:comment-${commentId}:attachment-delete:${++attachmentDeleteRequestId}`;
      pendingAttachmentDeletes.set(id, { resolve, reject });
      vscode.postMessage({
        command: 'deleteIssueCommentAttachment',
        instanceId,
        owner,
        repo,
        commentId,
        attachmentId,
        _requestId: id,
      });
    });
  }

  function mergePullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    strategy: 'merge' | 'rebase' | 'squash',
  ) {
    const key = pullRequestMergeFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'mergePullRequest', instanceId, owner, repo, index, strategy });
  }

  function uploadIssueAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    file: File,
  ): Promise<ForgejoIssueAttachment> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}#issue-${index}:attachment:${++attachmentUploadRequestId}`;
      pendingAttachmentUploads.set(id, { resolve, reject });
      const reader = new FileReader();
      reader.onload = () => {
        const array = new Uint8Array(reader.result as ArrayBuffer);
        vscode.postMessage({
          command: 'createIssueAttachment',
          instanceId,
          owner,
          repo,
          index,
          name: file.name,
          data: Array.from(array),
          _requestId: id,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  function uploadIssueCommentAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    commentId: number,
    file: File,
  ): Promise<ForgejoIssueAttachment> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}#issue-${index}:comment-${commentId}:attachment:${++attachmentUploadRequestId}`;
      pendingAttachmentUploads.set(id, { resolve, reject });
      const reader = new FileReader();
      reader.onload = () => {
        const array = new Uint8Array(reader.result as ArrayBuffer);
        vscode.postMessage({
          command: 'createIssueCommentAttachment',
          instanceId,
          owner,
          repo,
          index,
          commentId,
          name: file.name,
          data: Array.from(array),
          _requestId: id,
        });
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsArrayBuffer(file);
    });
  }

  function deleteIssueAttachment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    attachmentId: number,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const id = `${instanceId}:${owner}/${repo}#issue-${index}:attachment-delete:${++attachmentDeleteRequestId}`;
      pendingAttachmentDeletes.set(id, { resolve, reject });
      vscode.postMessage({
        command: 'deleteIssueAttachment',
        instanceId,
        owner,
        repo,
        index,
        attachmentId,
        _requestId: id,
      });
    });
  }

  function createPullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    title: string,
    body: string,
    base?: string,
    head?: string,
  ) {
    const key = pullRequestFormKey(instanceId, owner, repo, 0);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'createPullRequest', instanceId, owner, repo, data: { title, body, base, head } });
  }

  function editPullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: { title?: string; body?: string; state?: 'open' | 'closed' },
  ) {
    const key = pullRequestFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    vscode.postMessage({ command: 'editPullRequest', instanceId, owner, repo, index, data });
  }

  function openIssueDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'issueDetail', params: { instanceId, owner, repo, index: String(index) } });
    loadIssueDetail(instanceId, owner, repo, index);
  }

  function loadIssueDetail(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueDetailKey(instanceId, owner, repo, index);
    if (force || !issueDetails.value.has(key)) {
      loading.set(key, true);
      vscode.postMessage({ command: 'getIssueDetail', instanceId, owner, repo, index });
    }
  }

  function openPullRequestDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'pullRequestDetail', params: { instanceId, owner, repo, index: String(index) } });
    loadPullRequestDetail(instanceId, owner, repo, index);
  }

  function loadPullRequestDetail(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestDetailKey(instanceId, owner, repo, index);
    if (force || !pullRequestDetails.value.has(key)) {
      loading.set(key, true);
      vscode.postMessage({ command: 'getPullRequestDetail', instanceId, owner, repo, index });
    }
  }

  function loadPullRequestFiles(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    baseSha?: string,
    headSha?: string,
  ) {
    const key = pullRequestFilesKey(instanceId, owner, repo, index);
    if (pullRequestFiles.value.has(key)) {
      return;
    }
    vscode.postMessage({ command: 'getPullRequestFiles', instanceId, owner, repo, index, baseSha, headSha });
  }

  function loadPullRequestComments(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestCommentsKey(instanceId, owner, repo, index);
    if (!force && pullRequestComments.value.has(key)) {
      return;
    }
    vscode.postMessage({ command: 'getPullRequestCommentsAndTimeline', instanceId, owner, repo, index });
  }

  function loadPullRequestCommits(instanceId: string, owner: string, repo: string, index: number) {
    const key = pullRequestCommitsKey(instanceId, owner, repo, index);
    if (pullRequestCommits.value.has(key)) {
      return;
    }
    vscode.postMessage({ command: 'getPullRequestCommits', instanceId, owner, repo, index });
  }

  function openPullRequestDiff(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    filename: string,
    status: string,
    baseSha: string,
    headSha: string,
  ) {
    vscode.postMessage({
      command: 'openPullRequestDiff',
      instanceId,
      owner,
      repo,
      index,
      filename,
      status,
      baseSha,
      headSha,
    });
  }

  function openSelectedPullRequestDiffs(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    files: { filename: string; status: string }[],
    baseSha: string,
    headSha: string,
  ) {
    vscode.postMessage({
      command: 'openSelectedPullRequestDiffs',
      instanceId,
      owner,
      repo,
      index,
      files,
      baseSha,
      headSha,
    });
  }

  function openRepoIssues(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoIssues', params: { instanceId, owner, repo, state } });
    loadRepoIssues(instanceId, owner, repo, state);
  }

  function loadRepoIssues(instanceId: string, owner: string, repo: string, state = 'open') {
    const key = repoIssuesKey(instanceId, owner, repo, state);
    if (!repoIssues.value.has(key)) {
      loading.set(key, true);
      vscode.postMessage({ command: 'getRepoIssues', instanceId, owner, repo, state });
    }
  }

  function openRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoPullRequests', params: { instanceId, owner, repo, state } });
    loadRepoPullRequests(instanceId, owner, repo, state);
  }

  function loadRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open') {
    const key = repoPullRequestsKey(instanceId, owner, repo, state);
    if (!repoPullRequests.value.has(key)) {
      loading.set(key, true);
      vscode.postMessage({ command: 'getRepoPullRequests', instanceId, owner, repo, state });
    }
  }

  function changeRepoIssuesState(instanceId: string, owner: string, repo: string, newState: string) {
    router.replace({ name: 'repoIssues', params: { instanceId, owner, repo, state: newState } });
    loadRepoIssues(instanceId, owner, repo, newState);
  }

  function changeRepoPullRequestsState(instanceId: string, owner: string, repo: string, newState: string) {
    router.replace({ name: 'repoPullRequests', params: { instanceId, owner, repo, state: newState } });
    loadRepoPullRequests(instanceId, owner, repo, newState);
  }

  function openPrWorktree(instanceId: string, owner: string, repo: string, index: number) {
    vscode.postMessage({ command: 'openPrWorktree', instanceId, owner, repo, index });
  }

  function removeWorktree(id: string) {
    vscode.postMessage({ command: 'removeWorktree', id });
  }

  function changeWorktreeOpenMode(mode: 'ask' | 'currentWindow' | 'newWindow') {
    worktreeOpenMode.value = mode;
    vscode.postMessage({ command: 'setWorktreeOpenMode', mode });
  }

  function setWorktreeCacheDirectory(directory: string) {
    worktreeCacheDirectory.value = directory;
    vscode.postMessage({ command: 'setWorktreeCacheDirectory', directory });
  }

  function setDashboardActiveTab(tab: 'repositories' | 'issues' | 'pullRequests') {
    dashboardActiveTab.value = tab;
  }

  function browseWorktreeCacheDirectory() {
    vscode.postMessage({ command: 'browseWorktreeCacheDirectory' });
  }

  function renderMarkdown(instanceId: string, text: string, context?: string): Promise<string> {
    const key = `render-${++renderMarkdownRequestId}`;
    return new Promise((resolve, reject) => {
      pendingRenderMarkdownRequests.set(key, { resolve, reject });
      vscode.postMessage({ command: 'renderMarkdown', instanceId, text, context, key });
    });
  }

  function loadRepositories(instanceId: string) {
    const key = `repos-${instanceId}`;
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    vscode.postMessage({ command: 'getRepositories', instanceId });
  }

  function loadMyIssues(instanceId: string, state = 'open') {
    const key = `issues-${instanceId}`;
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    vscode.postMessage({ command: 'getMyIssues', instanceId, state });
  }

  function loadMyPullRequests(instanceId: string, state = 'open') {
    const key = `pulls-${instanceId}`;
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    vscode.postMessage({ command: 'getMyPullRequests', instanceId, state });
  }

  return {
    t,
    locale,
    instances,
    repositories,
    myIssues,
    myPullRequests,
    repoDetails,
    issueDetails,
    pullRequestDetails,
    repoIssues,
    repoPullRequests,
    repoBranchCommits,
    pullRequestFiles,
    pullRequestComments,
    pullRequestCommits,
    repoContents,
    repoRefs,
    repoFileSearchResults,
    fileHistories,
    loading,
    errors,
    debug,
    worktrees,
    worktreeOpenMode,
    worktreeCacheDirectory,
    worktreeCacheDirectoryDefault,
    vscodeVersion,
    supportsMultiDiff,
    dashboardActiveTab,
    testConnectionResult,
    saveInstanceResult,
    lastSavedIssue,
    lastSavedPullRequest,
    lastWorktreeCancelled,
    openExternal,
    copyToClipboard,
    previewReadme,
    testConnection,
    saveInstance,
    editInstance,
    removeInstance,
    changeLocale,
    changeDebug,
    openRepoDetail,
    loadRepoDetail,
    loadRepoBranchCommits,
    loadRepoContents,
    loadRepoFileSearch,
    loadFileHistory,
    loadRepoRefs,
    createRepoBranch,
    deleteRepoBranch,
    createRepoTag,
    deleteRepoTag,
    createRepoRelease,
    editRepoRelease,
    deleteRepoRelease,
    uploadReleaseAttachment,
    deleteReleaseAttachment,
    showInputBox,
    showConfirm,
    openRepoFile,
    openRepoFileDiff,
    createIssue,
    editIssue,
    createIssueComment,
    editIssueComment,
    deleteIssueComment,
    uploadIssueAttachment,
    uploadIssueCommentAttachment,
    deleteIssueAttachment,
    deleteIssueCommentAttachment,
    openIssueDetail,
    loadIssueDetail,
    createPullRequest,
    editPullRequest,
    mergePullRequest,
    openPullRequestDetail,
    loadPullRequestDetail,
    loadPullRequestFiles,
    loadPullRequestComments,
    loadPullRequestCommits,
    openPullRequestDiff,
    openSelectedPullRequestDiffs,
    openRepoIssues,
    loadRepoIssues,
    openRepoPullRequests,
    loadRepoPullRequests,
    changeRepoIssuesState,
    changeRepoPullRequestsState,
    openPrWorktree,
    removeWorktree,
    changeWorktreeOpenMode,
    setWorktreeCacheDirectory,
    browseWorktreeCacheDirectory,
    setDashboardActiveTab,
    renderMarkdown,
    loadRepositories,
    loadMyIssues,
    loadMyPullRequests,
  };
}

type AppState = ReturnType<typeof createAppState>;
let sharedState: AppState | undefined;

export function useAppState() {
  if (!sharedState) {
    sharedState = createAppState();
  }
  return sharedState;
}

export function repoDetailKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}`;
}

export function repoBranchCommitsKey(instanceId: string, owner: string, repo: string, branch: string): string {
  return `${instanceId}:${owner}/${repo}:branch:${branch}`;
}

export function issueFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:issue-form:${index}`;
}

export function issueDetailKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}`;
}

export function issueCommentFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:comment-form`;
}

export function issueCommentEditFormKey(instanceId: string, owner: string, repo: string, commentId: number): string {
  return `${instanceId}:${owner}/${repo}:comment-${commentId}:edit-form`;
}

export function issueCommentDeleteFormKey(instanceId: string, owner: string, repo: string, commentId: number): string {
  return `${instanceId}:${owner}/${repo}:comment-${commentId}:delete-form`;
}

export function pullRequestFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}:pr-form:${index}`;
}

export function pullRequestMergeFormKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:merge-form`;
}

export function pullRequestDetailKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}`;
}

export function pullRequestFilesKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:files`;
}

export function pullRequestCommentsKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:comments`;
}

export function pullRequestCommitsKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#pr-${index}:commits`;
}

export function repoIssuesKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:issues:${state}`;
}

export function repoPullRequestsKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:pulls:${state}`;
}

export function repoContentsKey(instanceId: string, owner: string, repo: string, ref: string, path: string): string {
  return `${instanceId}:${owner}/${repo}:contents:${ref}:${path}`;
}

export function repoRefsKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:refs`;
}

export function repoFileSearchKey(instanceId: string, owner: string, repo: string, ref: string, query: string): string {
  return `${instanceId}:${owner}/${repo}:file-search:${ref}:${query}`;
}

export function fileHistoryKey(instanceId: string, owner: string, repo: string, path: string, ref: string): string {
  return `${instanceId}:${owner}/${repo}:file-history:${path}:${ref}`;
}

function isVersionAtLeast(version: string, minimum: string): boolean {
  const parse = (v: string) => v.split('.').map((part) => Number.parseInt(part, 10) || 0);
  const current = parse(version);
  const required = parse(minimum);
  for (let i = 0; i < Math.max(current.length, required.length); i++) {
    const a = current[i] ?? 0;
    const b = required[i] ?? 0;
    if (a > b) {
      return true;
    }
    if (a < b) {
      return false;
    }
  }
  return true;
}
