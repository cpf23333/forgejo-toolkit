import { ref, reactive, onMounted, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';
import type { ForgejoInstance } from '../types/instance';

const loading = reactive(new Map<string, boolean>());
const errors = reactive(new Map<string, string>());
import '../types/config';
import { postMessage } from './vscode';

const vscodeVersion = window.__FORGEJO_TOOLKIT_CONFIG__?.vscodeVersion ?? '';
import type { Locale } from '../i18n';
import type {
  ForgejoActionRun,
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
  GlobalSearchResult,
  ForgejoNotification,
  ForgejoLabel,
  ForgejoMilestone,
  ForgejoReaction,
  ForgejoStopWatch,
  ForgejoTrackedTime,
  ForgejoWatchInfo,
} from '../types/api';
import type { GitEntry } from '@cpf23333-forgejo-toolkit/api';

import type {
  ExportSettings,
  HostToWebviewMessage,
  LinkedRepository,
} from '@cpf23333-forgejo-toolkit/shared/webview/messages';
import { createTimedCache } from '../utils/createTimedCache';

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
  const actionRuns = ref<Map<string, ForgejoActionRun[]>>(new Map());
  const actionRunTotalCount = ref<Map<string, number>>(new Map());
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
  const globalSearchResults = ref<Map<string, GlobalSearchResult>>(new Map());
  const globalSearchActiveScope = ref<'all' | 'repositories' | 'issues' | 'pullRequests'>('all');
  const globalSearchQuery = ref<string>('');
  const notifications = ref<Map<string, ForgejoNotification[]>>(new Map());
  const repoLabels = ref<Map<string, ForgejoLabel[]>>(new Map());
  const repoAssignees = ref<Map<string, string[]>>(new Map());
  const repoMilestones = ref<Map<string, ForgejoMilestone[]>>(new Map());
  const issueSubscriptions = ref<Map<string, ForgejoWatchInfo>>(new Map());
  const issueTrackedTimes = ref<Map<string, ForgejoTrackedTime[]>>(new Map());
  const issueDependencies = ref<Map<string, ForgejoIssue[]>>(new Map());
  const issueReactions = ref<Map<string, ForgejoReaction[]>>(new Map());
  const commentReactions = ref<Map<string, ForgejoReaction[]>>(new Map());
  const userStopwatches = ref<Map<string, ForgejoStopWatch[]>>(new Map());

  const repositoriesCache = createTimedCache<ForgejoRepository[]>(30_000);
  const myIssuesCache = createTimedCache<ForgejoIssue[]>(30_000);
  const myPullRequestsCache = createTimedCache<ForgejoPullRequest[]>(30_000);

  const repoContentsCache = createTimedCache<ForgejoContentEntry[]>(30_000);
  const repoRefsCache = createTimedCache<{ branches: ForgejoBranch[]; tags: ForgejoTag[]; releases: ForgejoRelease[] }>(
    30_000,
  );
  const repoBranchCommitsCache = createTimedCache<ForgejoCommit[]>(30_000);
  const pullRequestFilesCache = createTimedCache<ForgejoChangedFile[]>(30_000);
  const pullRequestCommitsCache = createTimedCache<ForgejoPullRequestCommit[]>(30_000);

  const issueDetailCache = createTimedCache<ForgejoIssueDetail>(5_000);
  const pullRequestDetailCache = createTimedCache<ForgejoPullRequestDetail>(5_000);
  const pullRequestCommentsCache = createTimedCache<ForgejoTimelineComment[]>(5_000);

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
  const linkedRepository = ref<LinkedRepository | undefined>(undefined);
  const testConnectionResult = ref<{ success: boolean; username?: string; error?: string } | undefined>(undefined);
  const saveInstanceResult = ref<{ success: boolean; error?: string } | undefined>(undefined);
  const exportInstancesResult = ref<{ success: boolean; path?: string; error?: string } | undefined>(undefined);
  const importInstancesResult = ref<{ success: boolean; count?: number; error?: string } | undefined>(undefined);
  const importPreview = ref<
    | {
        instances: ForgejoInstance[];
        existingIds: string[];
        existingTokens?: string[];
        settings?: ExportSettings;
      }
    | undefined
  >(undefined);
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
  let issueCommentCreationRequestId = 0;
  const pendingIssueCommentCreations = new Map<
    string,
    { resolve: (comment: ForgejoTimelineComment) => void; reject: (error: Error) => void }
  >();
  let issueCreationRequestId = 0;
  const pendingIssueCreations = new Map<
    string,
    { resolve: (issue: ForgejoIssue) => void; reject: (error: Error) => void }
  >();
  let pullRequestCreationRequestId = 0;
  const pendingPullRequestCreations = new Map<
    string,
    { resolve: (pr: ForgejoPullRequest) => void; reject: (error: Error) => void }
  >();
  let releaseCreationRequestId = 0;
  const pendingReleaseCreations = new Map<
    string,
    { resolve: (release: ForgejoRelease) => void; reject: (error: Error) => void }
  >();

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
        loadLinkedRepository();
        break;
      case 'linkedRepository':
        linkedRepository.value = (message as { linked?: LinkedRepository }).linked;
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
      case 'repoLabels':
        handleRepoLabels(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            labels?: ForgejoLabel[];
            error?: string;
          },
        );
        break;
      case 'repoAssignees':
        handleRepoAssignees(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            assignees?: string[];
            error?: string;
          },
        );
        break;
      case 'repoMilestones':
        handleRepoMilestones(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            milestones?: ForgejoMilestone[];
            error?: string;
          },
        );
        break;
      case 'issueSubscriptionChecked':
        handleIssueSubscriptionChecked(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            subscribed?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueSubscriptionChanged':
        handleIssueSubscriptionChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            subscribed?: boolean;
            error?: string;
          },
        );
        break;
      case 'issueStopwatchChanged':
        handleIssueStopwatchChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            action: 'start' | 'stop' | 'delete';
            error?: string;
          },
        );
        break;
      case 'userStopwatches':
        handleUserStopwatches(
          message as {
            instanceId: string;
            stopwatches?: ForgejoStopWatch[];
            error?: string;
          },
        );
        break;
      case 'issueTrackedTimes':
        handleIssueTrackedTimes(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            times?: ForgejoTrackedTime[];
            error?: string;
          },
        );
        break;
      case 'issueTimeAdded':
        handleIssueTimeAdded(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            time?: ForgejoTrackedTime;
            error?: string;
          },
        );
        break;
      case 'issueTimeReset':
        handleIssueTimeReset(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            error?: string;
          },
        );
        break;
      case 'issueTimeDeleted':
        handleIssueTimeDeleted(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            id: number;
            error?: string;
          },
        );
        break;
      case 'issueDependencies':
        handleIssueDependencies(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            dependencies?: ForgejoIssue[];
            error?: string;
          },
        );
        break;
      case 'issueDependencyChanged':
        handleIssueDependencyChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            dependencyIndex: number;
            action: 'add' | 'remove';
            error?: string;
          },
        );
        break;
      case 'issueReactions':
        handleIssueReactions(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            reactions?: ForgejoReaction[];
            error?: string;
          },
        );
        break;
      case 'issueReactionChanged':
        handleIssueReactionChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            index: number;
            content: string;
            action: 'add' | 'remove';
            error?: string;
          },
        );
        break;
      case 'commentReactions':
        handleCommentReactions(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            reactions?: ForgejoReaction[];
            error?: string;
          },
        );
        break;
      case 'commentReactionChanged':
        handleCommentReactionChanged(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            commentId: number;
            content: string;
            action: 'add' | 'remove';
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
            _requestId: string;
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
      case 'actionRuns':
        handleActionRuns(
          message as {
            instanceId: string;
            owner: string;
            repo: string;
            page: number;
            actionRuns?: ForgejoActionRun[];
            totalCount?: number;
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
      case 'globalSearchResult':
        handleGlobalSearchResult(
          message as {
            instanceId: string;
            scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
            query: string;
            state: string;
            repositories?: ForgejoRepository[];
            issues?: ForgejoIssue[];
            pullRequests?: ForgejoPullRequest[];
            error?: string;
          },
        );
        break;
      case 'notifications':
        handleNotifications(message as { instanceId: string; notifications?: ForgejoNotification[]; error?: string });
        break;
      case 'notificationMarkedRead':
        handleNotificationMarkedRead(message as { instanceId: string; id: number; error?: string });
        break;
      case 'allNotificationsMarkedRead':
        handleAllNotificationsMarkedRead(message as { instanceId: string; error?: string });
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
      case 'repoReleaseCreated': {
        const { instanceId, owner, repo, item, error, _requestId } = message as {
          instanceId: string;
          owner: string;
          repo: string;
          item?: unknown;
          error?: string;
          _requestId: string;
        };
        const pending = pendingReleaseCreations.get(_requestId);
        if (pending) {
          pendingReleaseCreations.delete(_requestId);
          if (error || !item) {
            pending.reject(new Error(error || 'Failed to create release'));
          } else {
            pending.resolve(item as ForgejoRelease);
          }
        }
        const key = repoRefsKey(instanceId, owner, repo);
        loading.set(key, false);
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
      case 'instancesExported':
        exportInstancesResult.value = message;
        break;
      case 'instancesImported':
        importInstancesResult.value = message;
        break;
      case 'importInstancesPreview':
        importPreview.value = {
          instances: (message as { instances?: ForgejoInstance[] }).instances ?? [],
          existingIds: (message as { existingIds?: string[] }).existingIds ?? [],
          existingTokens: (message as { existingTokens?: string[] }).existingTokens ?? [],
          settings: (message as { settings?: ExportSettings }).settings,
        };
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
      const list = data.repositories ?? [];
      repositories.value.set(data.instanceId, list);
      repositoriesCache.set(data.instanceId, list);
    }
  }

  function handleMyIssues(data: { instanceId: string; issues?: ForgejoIssue[]; error?: string }) {
    const key = `issues-${data.instanceId}`;
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      const list = data.issues ?? [];
      myIssues.value.set(data.instanceId, list);
      myIssuesCache.set(data.instanceId, list);
    }
  }

  function handleMyPullRequests(data: { instanceId: string; pullRequests?: ForgejoPullRequest[]; error?: string }) {
    const key = `pulls-${data.instanceId}`;
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      const list = data.pullRequests ?? [];
      myPullRequests.value.set(data.instanceId, list);
      myPullRequestsCache.set(data.instanceId, list);
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
      const list = data.commits ?? [];
      repoBranchCommits.value.set(key, list);
      repoBranchCommitsCache.set(key, list);
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
      issueDetailCache.set(key, data.detail);
    }
  }

  function handleRepoLabels(data: {
    instanceId: string;
    owner: string;
    repo: string;
    labels?: ForgejoLabel[];
    error?: string;
  }) {
    const key = repoLabelsKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoLabels.value.set(key, data.labels ?? []);
    }
  }

  function handleRepoAssignees(data: {
    instanceId: string;
    owner: string;
    repo: string;
    assignees?: string[];
    error?: string;
  }) {
    const key = repoAssigneesKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoAssignees.value.set(key, data.assignees ?? []);
    }
  }

  function handleRepoMilestones(data: {
    instanceId: string;
    owner: string;
    repo: string;
    milestones?: ForgejoMilestone[];
    error?: string;
  }) {
    const key = repoMilestonesKey(data.instanceId, data.owner, data.repo);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      repoMilestones.value.set(key, data.milestones ?? []);
    }
  }

  function handleIssueSubscriptionChecked(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    subscribed?: boolean;
    error?: string;
  }) {
    const key = issueSubscriptionKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      issueSubscriptions.value.set(key, { subscribed: data.subscribed });
    }
  }

  function handleIssueSubscriptionChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    subscribed?: boolean;
    error?: string;
  }) {
    const key = issueSubscriptionKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      issueSubscriptions.value.set(key, { subscribed: data.subscribed });
      loadIssueSubscription(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleIssueStopwatchChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    action: 'start' | 'stop' | 'delete';
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      loadIssueTrackedTimes(data.instanceId, data.owner, data.repo, data.index, true);
      loadUserStopwatches(data.instanceId, true);
    }
  }

  function handleUserStopwatches(data: { instanceId: string; stopwatches?: ForgejoStopWatch[]; error?: string }) {
    const key = userStopwatchesKey(data.instanceId);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      userStopwatches.value.set(key, data.stopwatches ?? []);
    }
  }

  function handleIssueTrackedTimes(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    times?: ForgejoTrackedTime[];
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      issueTrackedTimes.value.set(key, data.times ?? []);
    }
  }

  function handleIssueTimeAdded(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    time?: ForgejoTrackedTime;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      loadIssueTrackedTimes(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleIssueTimeReset(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      issueTrackedTimes.value.set(key, []);
    }
  }

  function handleIssueTimeDeleted(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    id: number;
    error?: string;
  }) {
    const key = issueTrackedTimesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      const list = issueTrackedTimes.value.get(key) ?? [];
      issueTrackedTimes.value.set(
        key,
        list.filter((t) => t.id !== data.id),
      );
    }
  }

  function handleIssueDependencies(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    dependencies?: ForgejoIssue[];
    error?: string;
  }) {
    const key = issueDependenciesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      issueDependencies.value.set(key, data.dependencies ?? []);
    }
  }

  function handleIssueDependencyChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    dependencyIndex: number;
    action: 'add' | 'remove';
    error?: string;
  }) {
    const key = issueDependenciesKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      loadIssueDependencies(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleIssueReactions(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    reactions?: ForgejoReaction[];
    error?: string;
  }) {
    const key = issueReactionsKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      issueReactions.value.set(key, data.reactions ?? []);
    }
  }

  function handleIssueReactionChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    index: number;
    content: string;
    action: 'add' | 'remove';
    error?: string;
  }) {
    const key = issueReactionsKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      loadIssueReactions(data.instanceId, data.owner, data.repo, data.index, true);
    }
  }

  function handleCommentReactions(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    reactions?: ForgejoReaction[];
    error?: string;
  }) {
    const key = commentReactionsKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      commentReactions.value.set(key, data.reactions ?? []);
    }
  }

  function handleCommentReactionChanged(data: {
    instanceId: string;
    owner: string;
    repo: string;
    commentId: number;
    content: string;
    action: 'add' | 'remove';
    error?: string;
  }) {
    const key = commentReactionsKey(data.instanceId, data.owner, data.repo, data.commentId);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      loadCommentReactions(data.instanceId, data.owner, data.repo, data.commentId, true);
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
      pullRequestDetailCache.set(key, data.detail);
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
      _requestId?: string;
    },
  ) {
    const formKey = issueFormKey(data.instanceId, data.owner, data.repo, command === 'issueUpdated' ? data.index : 0);
    loading.set(formKey, false);
    if (command === 'issueCreated' && data._requestId) {
      const pending = pendingIssueCreations.get(data._requestId);
      if (pending) {
        pendingIssueCreations.delete(data._requestId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else if (data.item) {
          pending.resolve(data.item);
        } else {
          pending.reject(new Error('Issue creation failed'));
        }
      }
    }
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.item) {
      repoIssues.value.clear();
      myIssues.value.clear();
      myIssuesCache.clear();
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
    _requestId: string;
  }) {
    const formKey = issueCommentFormKey(data.instanceId, data.owner, data.repo, data.index);
    loading.set(formKey, false);
    const pending = pendingIssueCommentCreations.get(data._requestId);
    if (pending) {
      pendingIssueCommentCreations.delete(data._requestId);
      if (data.error) {
        pending.reject(new Error(data.error));
      } else if (data.comment) {
        pending.resolve(data.comment);
      } else {
        pending.reject(new Error('Comment creation failed'));
      }
    }
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
    myPullRequestsCache.clear();
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
      _requestId?: string;
    },
  ) {
    const formKey = pullRequestFormKey(
      data.instanceId,
      data.owner,
      data.repo,
      command === 'pullRequestUpdated' ? data.index : 0,
    );
    loading.set(formKey, false);
    if (command === 'pullRequestCreated' && data._requestId) {
      const pending = pendingPullRequestCreations.get(data._requestId);
      if (pending) {
        pendingPullRequestCreations.delete(data._requestId);
        if (data.error) {
          pending.reject(new Error(data.error));
        } else if (data.item) {
          pending.resolve(data.item);
        } else {
          pending.reject(new Error('Pull request creation failed'));
        }
      }
    }
    if (data.error) {
      errors.set(formKey, data.error);
      return;
    }
    errors.delete(formKey);
    if (data.item) {
      repoPullRequests.value.clear();
      myPullRequests.value.clear();
      myPullRequestsCache.clear();
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
      const list = data.files ?? [];
      pullRequestFiles.value.set(key, list);
      pullRequestFilesCache.set(key, list);
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
      const list = data.comments ?? [];
      pullRequestComments.value.set(key, list);
      pullRequestCommentsCache.set(key, list);
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
      const list = data.commits ?? [];
      pullRequestCommits.value.set(key, list);
      pullRequestCommitsCache.set(key, list);
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

  function handleActionRuns(data: {
    instanceId: string;
    owner: string;
    repo: string;
    page: number;
    actionRuns?: ForgejoActionRun[];
    totalCount?: number;
    error?: string;
  }) {
    const key = actionRunsKey(data.instanceId, data.owner, data.repo, data.page);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
    } else {
      errors.delete(key);
      actionRuns.value.set(key, data.actionRuns ?? []);
      actionRunTotalCount.value.set(
        `${data.instanceId}:${data.owner}/${data.repo}`,
        data.totalCount ?? data.actionRuns?.length ?? 0,
      );
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
      const list = data.entries ?? [];
      repoContents.value.set(key, list);
      repoContentsCache.set(key, list);
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

  function handleGlobalSearchResult(data: {
    instanceId: string;
    scope: 'all' | 'repositories' | 'issues' | 'pullRequests';
    query: string;
    state: string;
    repositories?: ForgejoRepository[];
    issues?: ForgejoIssue[];
    pullRequests?: ForgejoPullRequest[];
    error?: string;
  }) {
    const key = globalSearchKey(data.instanceId, data.scope, data.query, data.state);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
      return;
    }
    errors.delete(key);
    const existing = globalSearchResults.value.get(key) ?? {
      repositories: [],
      issues: [],
      pullRequests: [],
    };
    globalSearchResults.value.set(key, {
      repositories: data.repositories ?? existing.repositories,
      issues: data.issues ?? existing.issues,
      pullRequests: data.pullRequests ?? existing.pullRequests,
    });
  }

  function handleNotifications(data: { instanceId: string; notifications?: ForgejoNotification[]; error?: string }) {
    const key = notificationsKey(data.instanceId);
    loading.set(key, false);
    if (data.error) {
      errors.set(key, data.error);
      return;
    }
    errors.delete(key);
    notifications.value.set(key, data.notifications ?? []);
  }

  function handleNotificationMarkedRead(data: { instanceId: string; id: number; error?: string }) {
    const key = notificationsKey(data.instanceId);
    if (data.error) {
      errors.set(key, data.error);
      return;
    }
    const list = notifications.value.get(key) ?? [];
    notifications.value.set(
      key,
      list.map((notification) => (notification.id === data.id ? { ...notification, unread: false } : notification)),
    );
  }

  function handleAllNotificationsMarkedRead(data: { instanceId: string; error?: string }) {
    const key = notificationsKey(data.instanceId);
    if (data.error) {
      errors.set(key, data.error);
      return;
    }
    const list = notifications.value.get(key) ?? [];
    notifications.value.set(
      key,
      list.map((notification) => ({ ...notification, unread: false })),
    );
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
      const value = {
        branches: data.branches ?? [],
        tags: data.tags ?? [],
        releases: data.releases ?? [],
      };
      repoRefs.value.set(key, value);
      repoRefsCache.set(key, value);
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
    postMessage({ command: 'getInitialState' });
  });

  function openExternal(url: string) {
    postMessage({ command: 'openExternal', url });
  }

  function copyToClipboard(text: string) {
    postMessage({ command: 'copyToClipboard', text });
  }

  function previewReadme(owner: string, repo: string, content: string) {
    postMessage({ command: 'previewReadme', owner, repo, content });
  }

  function testConnection(url: string, token: string) {
    postMessage({ command: 'testConnection', url, token });
  }

  function saveInstance(url: string, token: string) {
    postMessage({ command: 'saveInstance', url, token });
  }

  function editInstance(id: string, url: string, token: string) {
    postMessage({ command: 'editInstance', id, url, token });
  }

  function removeInstance(id: string) {
    postMessage({ command: 'removeInstance', id });
  }

  function exportInstances(ids?: string[]) {
    postMessage({ command: 'exportInstances', ids });
  }

  function copyInstancesToClipboard(ids?: string[]) {
    postMessage({ command: 'copyInstancesToClipboard', ids });
  }

  function previewImportInstances() {
    postMessage({ command: 'previewImportInstances' });
  }

  function confirmImportInstances(instances: ForgejoInstance[], settings?: ExportSettings) {
    postMessage({
      command: 'importInstances',
      instances: instances.map((instance) => ({ ...instance })),
      settings: settings ? { ...settings } : undefined,
    });
  }

  function changeLocale(newLocale: Locale) {
    locale.value = newLocale;
    postMessage({ command: 'setLocale', locale: newLocale });
  }

  function changeDebug(newDebug: boolean) {
    debug.value = newDebug;
    postMessage({ command: 'setDebug', debug: newDebug });
  }

  function openRepoDetail(instanceId: string, owner: string, repo: string) {
    router.push({ name: 'repoDetail', params: { instanceId, owner, repo } });
    loadRepoDetail(instanceId, owner, repo);
  }

  function loadRepoDetail(instanceId: string, owner: string, repo: string) {
    const key = repoDetailKey(instanceId, owner, repo);
    if (!repoDetails.value.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getRepoDetail', instanceId, owner, repo });
    }
  }

  function loadRepoBranchCommits(instanceId: string, owner: string, repo: string, branch: string, force = false) {
    const key = repoBranchCommitsKey(instanceId, owner, repo, branch);
    if (!force && repoBranchCommitsCache.has(key)) {
      return;
    }
    loading.set(key, true);
    postMessage({ command: 'getRepoBranchCommits', instanceId, owner, repo, branch });
  }

  function openRepoFile(instanceId: string, owner: string, repo: string, path: string, ref: string) {
    postMessage({ command: 'openRepoFile', instanceId, owner, repo, path, ref });
  }

  function openRepoFileDiff(
    instanceId: string,
    owner: string,
    repo: string,
    path: string,
    baseRef: string,
    headRef: string,
  ) {
    postMessage({ command: 'openRepoFileDiff', instanceId, owner, repo, path, baseRef, headRef });
  }

  function loadRepoContents(instanceId: string, owner: string, repo: string, path: string, ref: string, force = false) {
    const key = repoContentsKey(instanceId, owner, repo, ref, path);
    if (!force && repoContentsCache.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getRepoContents', instanceId, owner, repo, path, ref });
  }

  function loadRepoFileSearch(instanceId: string, owner: string, repo: string, ref: string, query: string) {
    const key = repoFileSearchKey(instanceId, owner, repo, ref, query);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'searchRepoFiles', instanceId, owner, repo, ref, query });
  }

  function loadFileHistory(instanceId: string, owner: string, repo: string, path: string, ref: string) {
    const key = fileHistoryKey(instanceId, owner, repo, path, ref);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getFileHistory', instanceId, owner, repo, path, ref });
  }

  function loadRepoRefs(instanceId: string, owner: string, repo: string, force = false) {
    const key = repoRefsKey(instanceId, owner, repo);
    if (!force && repoRefsCache.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getRepoRefs', instanceId, owner, repo });
  }

  function createRepoBranch(
    instanceId: string,
    owner: string,
    repo: string,
    newBranchName: string,
    oldRefName?: string,
  ) {
    postMessage({ command: 'createRepoBranch', instanceId, owner, repo, newBranchName, oldRefName });
  }

  function deleteRepoBranch(instanceId: string, owner: string, repo: string, branch: string) {
    postMessage({ command: 'deleteRepoBranch', instanceId, owner, repo, branch });
  }

  function createRepoTag(
    instanceId: string,
    owner: string,
    repo: string,
    tagName: string,
    target?: string,
    message?: string,
  ) {
    postMessage({ command: 'createRepoTag', instanceId, owner, repo, tagName, target, message });
  }

  function deleteRepoTag(instanceId: string, owner: string, repo: string, tag: string) {
    postMessage({ command: 'deleteRepoTag', instanceId, owner, repo, tag });
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
  ): Promise<ForgejoRelease> {
    const key = repoRefsKey(instanceId, owner, repo);
    loading.set(key, true);
    errors.delete(key);
    const _requestId = `release-create-${++releaseCreationRequestId}`;
    return new Promise((resolve, reject) => {
      pendingReleaseCreations.set(_requestId, { resolve, reject });
      postMessage({
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
        _requestId,
      });
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
    postMessage({ command: 'editRepoRelease', instanceId, owner, repo, id, data });
  }

  function deleteRepoRelease(instanceId: string, owner: string, repo: string, id: number) {
    postMessage({ command: 'deleteRepoRelease', instanceId, owner, repo, id });
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
      postMessage({
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
      postMessage({
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
      postMessage({ command: 'showInputBox', id, ...options });
    });
  }

  function showConfirm(message: string): Promise<boolean> {
    const id = `confirm-${++inputRequestId}`;
    return new Promise((resolve) => {
      confirmPromises.set(id, resolve);
      postMessage({ command: 'showConfirm', id, message });
    });
  }

  function createIssue(
    instanceId: string,
    owner: string,
    repo: string,
    data: {
      title: string;
      body: string;
      ref?: string;
      labels?: number[];
      assignees?: string[];
      milestone?: number;
      dueDate?: string;
    },
  ): Promise<ForgejoIssue> {
    const key = issueFormKey(instanceId, owner, repo, 0);
    loading.set(key, true);
    errors.delete(key);
    const _requestId = `issue-create-${++issueCreationRequestId}`;
    return new Promise((resolve, reject) => {
      pendingIssueCreations.set(_requestId, { resolve, reject });
      postMessage({
        command: 'createIssue',
        instanceId,
        owner,
        repo,
        data: {
          title: data.title,
          body: data.body,
          ref: data.ref,
          labels: data.labels,
          assignees: data.assignees,
          milestone: data.milestone,
          due_date: data.dueDate,
        },
        _requestId,
      });
    });
  }

  function editIssue(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      labels?: number[];
      assignees?: string[];
      milestone?: number;
      dueDate?: string;
      unsetDueDate?: boolean;
    },
  ) {
    const key = issueFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({
      command: 'editIssue',
      instanceId,
      owner,
      repo,
      index,
      data: {
        title: data.title,
        body: data.body,
        state: data.state,
        labels: data.labels,
        assignees: data.assignees,
        milestone: data.milestone,
        due_date: data.dueDate,
        unset_due_date: data.unsetDueDate,
      },
    });
  }

  function createIssueComment(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    body: string,
  ): Promise<ForgejoTimelineComment> {
    const key = issueCommentFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    const _requestId = `issue-comment-create-${++issueCommentCreationRequestId}`;
    return new Promise((resolve, reject) => {
      pendingIssueCommentCreations.set(_requestId, { resolve, reject });
      postMessage({ command: 'createIssueComment', instanceId, owner, repo, index, body, _requestId });
    });
  }

  function editIssueComment(instanceId: string, owner: string, repo: string, commentId: number, body: string) {
    const key = issueCommentEditFormKey(instanceId, owner, repo, commentId);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'editIssueComment', instanceId, owner, repo, commentId, body });
  }

  async function deleteIssueComment(instanceId: string, owner: string, repo: string, commentId: number) {
    const confirmed = await showConfirm(t('dashboard.detail.confirmDeleteComment'));
    if (!confirmed) {
      return;
    }
    const key = issueCommentDeleteFormKey(instanceId, owner, repo, commentId);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'deleteIssueComment', instanceId, owner, repo, commentId });
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
      postMessage({
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
    postMessage({ command: 'mergePullRequest', instanceId, owner, repo, index, strategy });
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
        postMessage({
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
        postMessage({
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
      postMessage({
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
    data: {
      title: string;
      body: string;
      base?: string;
      head?: string;
      assignees?: string[];
      labels?: number[];
      milestone?: number;
      dueDate?: string;
    },
  ): Promise<ForgejoPullRequest> {
    const key = pullRequestFormKey(instanceId, owner, repo, 0);
    loading.set(key, true);
    errors.delete(key);
    const _requestId = `pull-request-create-${++pullRequestCreationRequestId}`;
    return new Promise((resolve, reject) => {
      pendingPullRequestCreations.set(_requestId, { resolve, reject });
      postMessage({
        command: 'createPullRequest',
        instanceId,
        owner,
        repo,
        data: {
          title: data.title,
          body: data.body,
          base: data.base,
          head: data.head,
          assignees: data.assignees,
          labels: data.labels,
          milestone: data.milestone,
          due_date: data.dueDate,
        },
        _requestId,
      });
    });
  }

  function editPullRequest(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    data: {
      title?: string;
      body?: string;
      state?: 'open' | 'closed';
      base?: string;
      assignees?: string[];
      labels?: number[];
      milestone?: number;
      dueDate?: string;
      unsetDueDate?: boolean;
    },
  ) {
    const key = pullRequestFormKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({
      command: 'editPullRequest',
      instanceId,
      owner,
      repo,
      index,
      data: {
        title: data.title,
        body: data.body,
        state: data.state,
        base: data.base,
        assignees: data.assignees,
        labels: data.labels,
        milestone: data.milestone,
        due_date: data.dueDate,
        unset_due_date: data.unsetDueDate,
      },
    });
  }

  function openIssueDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'issueDetail', params: { instanceId, owner, repo, index: String(index) } });
    loadIssueDetail(instanceId, owner, repo, index);
  }

  function loadIssueDetail(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueDetailKey(instanceId, owner, repo, index);
    if (force || !issueDetailCache.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getIssueDetail', instanceId, owner, repo, index });
    }
  }

  function openPullRequestDetail(instanceId: string, owner: string, repo: string, index: number) {
    router.push({ name: 'pullRequestDetail', params: { instanceId, owner, repo, index: String(index) } });
    loadPullRequestDetail(instanceId, owner, repo, index);
  }

  function loadPullRequestDetail(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestDetailKey(instanceId, owner, repo, index);
    if (force || !pullRequestDetailCache.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getPullRequestDetail', instanceId, owner, repo, index });
    }
  }

  function loadPullRequestFiles(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    baseSha?: string,
    headSha?: string,
    force = false,
  ) {
    const key = pullRequestFilesKey(instanceId, owner, repo, index);
    if (!force && pullRequestFilesCache.has(key)) {
      return;
    }
    postMessage({ command: 'getPullRequestFiles', instanceId, owner, repo, index, baseSha, headSha });
  }

  function loadPullRequestComments(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestCommentsKey(instanceId, owner, repo, index);
    if (!force && pullRequestCommentsCache.has(key)) {
      return;
    }
    postMessage({ command: 'getPullRequestCommentsAndTimeline', instanceId, owner, repo, index });
  }

  function loadPullRequestCommits(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = pullRequestCommitsKey(instanceId, owner, repo, index);
    if (!force && pullRequestCommitsCache.has(key)) {
      return;
    }
    postMessage({ command: 'getPullRequestCommits', instanceId, owner, repo, index });
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
    postMessage({
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
    postMessage({
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
      postMessage({ command: 'getRepoIssues', instanceId, owner, repo, state });
    }
  }

  function loadRepoLabels(instanceId: string, owner: string, repo: string) {
    const key = repoLabelsKey(instanceId, owner, repo);
    if (!repoLabels.value.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getRepoLabels', instanceId, owner, repo });
    }
  }

  function loadRepoAssignees(instanceId: string, owner: string, repo: string) {
    const key = repoAssigneesKey(instanceId, owner, repo);
    if (!repoAssignees.value.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getRepoAssignees', instanceId, owner, repo });
    }
  }

  function loadRepoMilestones(instanceId: string, owner: string, repo: string) {
    const key = repoMilestonesKey(instanceId, owner, repo);
    if (!repoMilestones.value.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getRepoMilestones', instanceId, owner, repo });
    }
  }

  function loadIssueSubscription(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueSubscriptionKey(instanceId, owner, repo, index);
    if (!force && issueSubscriptions.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'checkIssueSubscription', instanceId, owner, repo, index });
  }

  function changeIssueSubscription(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    user: string,
    subscribe: boolean,
  ) {
    const key = issueSubscriptionKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'changeIssueSubscription', instanceId, owner, repo, index, user, subscribe });
  }

  function loadUserStopwatches(instanceId: string, force = false) {
    const key = userStopwatchesKey(instanceId);
    if (!force && userStopwatches.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getUserStopwatches', instanceId });
  }

  function loadIssueTrackedTimes(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    if (!force && issueTrackedTimes.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getIssueTrackedTimes', instanceId, owner, repo, index });
  }

  function startIssueStopwatch(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'startIssueStopwatch', instanceId, owner, repo, index });
  }

  function stopIssueStopwatch(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'stopIssueStopwatch', instanceId, owner, repo, index });
  }

  function deleteIssueStopwatch(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'deleteIssueStopwatch', instanceId, owner, repo, index });
  }

  function addIssueTime(instanceId: string, owner: string, repo: string, index: number, time: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'addIssueTime', instanceId, owner, repo, index, time });
  }

  function resetIssueTime(instanceId: string, owner: string, repo: string, index: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'resetIssueTime', instanceId, owner, repo, index });
  }

  function deleteIssueTime(instanceId: string, owner: string, repo: string, index: number, id: number) {
    const key = issueTrackedTimesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'deleteIssueTime', instanceId, owner, repo, index, id });
  }

  function loadIssueDependencies(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueDependenciesKey(instanceId, owner, repo, index);
    if (!force && issueDependencies.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getIssueDependencies', instanceId, owner, repo, index });
  }

  function createIssueDependency(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    dependencyIndex: number,
  ) {
    const key = issueDependenciesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'createIssueDependency', instanceId, owner, repo, index, dependencyIndex });
  }

  function removeIssueDependency(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    dependencyIndex: number,
  ) {
    const key = issueDependenciesKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'removeIssueDependency', instanceId, owner, repo, index, dependencyIndex });
  }

  function loadIssueReactions(instanceId: string, owner: string, repo: string, index: number, force = false) {
    const key = issueReactionsKey(instanceId, owner, repo, index);
    if (!force && issueReactions.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getIssueReactions', instanceId, owner, repo, index });
  }

  function changeIssueReaction(
    instanceId: string,
    owner: string,
    repo: string,
    index: number,
    content: string,
    add: boolean,
  ) {
    const key = issueReactionsKey(instanceId, owner, repo, index);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'changeIssueReaction', instanceId, owner, repo, index, content, add });
  }

  function loadCommentReactions(instanceId: string, owner: string, repo: string, commentId: number, force = false) {
    const key = commentReactionsKey(instanceId, owner, repo, commentId);
    if (!force && commentReactions.value.has(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getCommentReactions', instanceId, owner, repo, commentId });
  }

  function changeCommentReaction(
    instanceId: string,
    owner: string,
    repo: string,
    commentId: number,
    content: string,
    add: boolean,
  ) {
    const key = commentReactionsKey(instanceId, owner, repo, commentId);
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'changeCommentReaction', instanceId, owner, repo, commentId, content, add });
  }

  function openRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open') {
    router.push({ name: 'repoPullRequests', params: { instanceId, owner, repo, state } });
    loadRepoPullRequests(instanceId, owner, repo, state);
  }

  function loadRepoPullRequests(instanceId: string, owner: string, repo: string, state = 'open') {
    const key = repoPullRequestsKey(instanceId, owner, repo, state);
    if (!repoPullRequests.value.has(key)) {
      loading.set(key, true);
      postMessage({ command: 'getRepoPullRequests', instanceId, owner, repo, state });
    }
  }

  function loadActionRuns(instanceId: string, owner: string, repo: string, page = 1, force = false) {
    const key = actionRunsKey(instanceId, owner, repo, page);
    if (force || !actionRuns.value.has(key)) {
      loading.set(key, true);
      errors.delete(key);
      postMessage({ command: 'getActionRuns', instanceId, owner, repo, page, limit: 30 });
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

  function loadLinkedRepository() {
    postMessage({ command: 'getLinkedRepository' });
  }

  function openLinkedRepositoryDetail() {
    const linked = linkedRepository.value;
    if (!linked) {
      return;
    }
    openRepoDetail(linked.instanceId, linked.owner, linked.repo);
  }

  function openLinkedRepositoryIssues() {
    const linked = linkedRepository.value;
    if (!linked) {
      return;
    }
    openRepoIssues(linked.instanceId, linked.owner, linked.repo);
  }

  function openLinkedRepositoryPullRequests() {
    const linked = linkedRepository.value;
    if (!linked) {
      return;
    }
    openRepoPullRequests(linked.instanceId, linked.owner, linked.repo);
  }

  function openPrWorktree(instanceId: string, owner: string, repo: string, index: number) {
    postMessage({ command: 'openPrWorktree', instanceId, owner, repo, index });
  }

  function removeWorktree(id: string) {
    postMessage({ command: 'removeWorktree', id });
  }

  function changeWorktreeOpenMode(mode: 'ask' | 'currentWindow' | 'newWindow') {
    worktreeOpenMode.value = mode;
    postMessage({ command: 'setWorktreeOpenMode', mode });
  }

  function setWorktreeCacheDirectory(directory: string) {
    worktreeCacheDirectory.value = directory;
    postMessage({ command: 'setWorktreeCacheDirectory', directory });
  }

  function setDashboardActiveTab(tab: 'repositories' | 'issues' | 'pullRequests') {
    dashboardActiveTab.value = tab;
  }

  function browseWorktreeCacheDirectory() {
    postMessage({ command: 'browseWorktreeCacheDirectory' });
  }

  function renderMarkdown(instanceId: string, text: string, context?: string): Promise<string> {
    const key = `render-${++renderMarkdownRequestId}`;
    return new Promise((resolve, reject) => {
      pendingRenderMarkdownRequests.set(key, { resolve, reject });
      postMessage({ command: 'renderMarkdown', instanceId, text, context, key });
    });
  }

  function loadRepositories(instanceId: string, force = false) {
    console.log('[useAppState] loadRepositories', instanceId);
    const key = `repos-${instanceId}`;
    if (!force && repositoriesCache.has(instanceId)) {
      console.log('[useAppState] loadRepositories skipped, cached', instanceId);
      return;
    }
    if (loading.get(key)) {
      console.log('[useAppState] loadRepositories skipped, already loading', instanceId);
      return;
    }
    loading.set(key, true);
    postMessage({ command: 'getRepositories', instanceId });
  }

  function loadMyIssues(instanceId: string, state = 'open', force = false) {
    const key = `issues-${instanceId}`;
    if (!force && myIssuesCache.has(instanceId)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    postMessage({ command: 'getMyIssues', instanceId, state });
  }

  function loadMyPullRequests(instanceId: string, state = 'open', force = false) {
    const key = `pulls-${instanceId}`;
    if (!force && myPullRequestsCache.has(instanceId)) {
      return;
    }
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    postMessage({ command: 'getMyPullRequests', instanceId, state });
  }

  function loadGlobalSearch(
    instanceId: string,
    scope: 'all' | 'repositories' | 'issues' | 'pullRequests',
    query: string,
    state: string = 'all',
  ) {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    const key = globalSearchKey(instanceId, scope, trimmed, state);
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'globalSearch', instanceId, scope, query: trimmed, state, limit: 20 });
  }

  function setGlobalSearchScope(scope: 'all' | 'repositories' | 'issues' | 'pullRequests') {
    globalSearchActiveScope.value = scope;
  }

  function setGlobalSearchQuery(query: string) {
    globalSearchQuery.value = query;
  }

  function loadNotifications(instanceId: string, statusTypes: string[] = ['unread', 'pinned'], subjectType?: string[]) {
    const key = notificationsKey(instanceId);
    if (loading.get(key)) {
      return;
    }
    loading.set(key, true);
    errors.delete(key);
    postMessage({ command: 'getNotifications', instanceId, statusTypes, subjectType, limit: 50 });
  }

  function markNotificationRead(instanceId: string, id: number) {
    postMessage({ command: 'markNotificationRead', instanceId, id });
  }

  function markAllNotificationsRead(instanceId: string) {
    postMessage({ command: 'markAllNotificationsRead', instanceId });
  }

  const unreadNotificationCount = computed(() => {
    let count = 0;
    for (const instance of instances.value) {
      const list = notifications.value.get(notificationsKey(instance.id)) ?? [];
      count += list.filter((notification) => notification.unread).length;
    }
    return count;
  });

  return {
    t,
    locale,
    instances,
    repositories,
    repositoriesCache,
    myIssues,
    myIssuesCache,
    myPullRequests,
    myPullRequestsCache,
    repoDetails,
    issueDetails,
    pullRequestDetails,
    repoIssues,
    repoPullRequests,
    actionRuns,
    actionRunTotalCount,
    repoBranchCommits,
    pullRequestFiles,
    pullRequestComments,
    pullRequestCommits,
    repoContents,
    repoRefs,
    repoFileSearchResults,
    fileHistories,
    globalSearchResults,
    globalSearchActiveScope,
    globalSearchQuery,
    notifications,
    unreadNotificationCount,
    repoLabels,
    repoAssignees,
    repoMilestones,
    issueSubscriptions,
    issueTrackedTimes,
    issueDependencies,
    issueReactions,
    commentReactions,
    userStopwatches,
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
    linkedRepository,
    testConnectionResult,
    saveInstanceResult,
    exportInstancesResult,
    importInstancesResult,
    importPreview,
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
    exportInstances,
    copyInstancesToClipboard,
    previewImportInstances,
    confirmImportInstances,
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
    loadRepoLabels,
    loadRepoAssignees,
    loadRepoMilestones,
    loadIssueSubscription,
    changeIssueSubscription,
    loadIssueTrackedTimes,
    loadUserStopwatches,
    startIssueStopwatch,
    stopIssueStopwatch,
    deleteIssueStopwatch,
    addIssueTime,
    resetIssueTime,
    deleteIssueTime,
    loadIssueDependencies,
    createIssueDependency,
    removeIssueDependency,
    loadIssueReactions,
    changeIssueReaction,
    loadCommentReactions,
    changeCommentReaction,
    openRepoPullRequests,
    loadRepoPullRequests,
    loadActionRuns,
    changeRepoIssuesState,
    changeRepoPullRequestsState,
    loadLinkedRepository,
    openLinkedRepositoryDetail,
    openLinkedRepositoryIssues,
    openLinkedRepositoryPullRequests,
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
    loadGlobalSearch,
    setGlobalSearchScope,
    setGlobalSearchQuery,
    loadNotifications,
    markNotificationRead,
    markAllNotificationsRead,
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

export function repoLabelsKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:labels`;
}

export function repoAssigneesKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:assignees`;
}

export function repoMilestonesKey(instanceId: string, owner: string, repo: string): string {
  return `${instanceId}:${owner}/${repo}:milestones`;
}

export function issueSubscriptionKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:subscription`;
}

export function issueTrackedTimesKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:tracked-times`;
}

export function userStopwatchesKey(instanceId: string): string {
  return `${instanceId}:user-stopwatches`;
}

export function issueDependenciesKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:dependencies`;
}

export function issueReactionsKey(instanceId: string, owner: string, repo: string, index: number): string {
  return `${instanceId}:${owner}/${repo}#issue-${index}:reactions`;
}

export function commentReactionsKey(instanceId: string, owner: string, repo: string, commentId: number): string {
  return `${instanceId}:${owner}/${repo}:comment-${commentId}:reactions`;
}

export function repoPullRequestsKey(instanceId: string, owner: string, repo: string, state: string): string {
  return `${instanceId}:${owner}/${repo}:pulls:${state}`;
}

export function actionRunsKey(instanceId: string, owner: string, repo: string, page: number): string {
  return `${instanceId}:${owner}/${repo}:actions:page-${page}`;
}

export function repoContentsKey(instanceId: string, owner: string, repo: string, ref: string, path: string) {
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

export function globalSearchKey(
  instanceId: string,
  scope: 'all' | 'repositories' | 'issues' | 'pullRequests',
  query: string,
  state: string = 'all',
): string {
  return `${instanceId}:global-search:${scope}:${state}:${query}`;
}

export function notificationsKey(instanceId: string): string {
  return `${instanceId}:notifications`;
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
