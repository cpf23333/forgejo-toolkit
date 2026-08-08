<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import MarkdownBody from '../components/MarkdownBody.vue';
import AttachmentList from '../components/AttachmentList.vue';
import PendingAttachmentList from '../components/PendingAttachmentList.vue';
import DiffFileList from '../components/DiffFileList.vue';
import CommentTimeline from '../components/CommentTimeline.vue';
import CommitDiffList from '../components/CommitDiffList.vue';
import ModalDialog from '../components/ModalDialog.vue';
import PullRequestForm from '../components/PullRequestForm.vue';
import EasyMdeEditor from '../components/EasyMdeEditor.vue';
import ReactionBar from '../components/ReactionBar.vue';
import { CollapsibleSection, VscodeDateField } from '../vscode-controls';
import {
  useAppState,
  pullRequestDetailKey,
  pullRequestFilesKey,
  pullRequestCommentsKey,
  pullRequestCommitsKey,
  pullRequestFormKey,
  pullRequestMergeFormKey,
  issueCommentFormKey,
  repoDetailKey,
  repoLabelsKey,
  repoAssigneesKey,
  repoMilestonesKey,
  repoIssuesKey,
  issueSubscriptionKey,
  issueTrackedTimesKey,
  userStopwatchesKey,
  issueDependenciesKey,
  issueReactionsKey,
} from '../composables/useAppState';
import type { ForgejoIssueAttachment, MergeBlocker } from '../types/api';

const { t } = useI18n();
const route = useRoute();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const index = computed(() => Number(route.params.index));
const key = computed(() => pullRequestDetailKey(instanceId.value, owner.value, repo.value, index.value));

const detail = computed(() => state.pullRequestDetails.value.get(key.value));
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));
const baseUrl = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.url);
const currentUsername = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.username);
const isPullRequestAuthor = computed(
  () => detail.value?.user?.login === currentUsername.value && currentUsername.value !== undefined,
);
const canManagePullRequest = computed(() => {
  if (isPullRequestAuthor.value) {
    return true;
  }
  const permissions = detail.value?.repoPermissions;
  return permissions?.admin === true || permissions?.push === true;
});

const filesKey = computed(() => pullRequestFilesKey(instanceId.value, owner.value, repo.value, index.value));
const files = computed(() => state.pullRequestFiles.value.get(filesKey.value) ?? []);
const filesError = computed(() => state.errors.get(filesKey.value));
const filesLoading = computed(() => files.value.length === 0 && !filesError.value);

const commentsKey = computed(() => pullRequestCommentsKey(instanceId.value, owner.value, repo.value, index.value));
const comments = computed(() => state.pullRequestComments.value.get(commentsKey.value) ?? []);
const commentsError = computed(() => state.errors.get(commentsKey.value));
const commentsLoading = computed(() => !state.pullRequestComments.value.has(commentsKey.value) && !commentsError.value);

const commitsKey = computed(() => pullRequestCommitsKey(instanceId.value, owner.value, repo.value, index.value));
const commits = computed(() => state.pullRequestCommits.value.get(commitsKey.value) ?? []);
const commitsError = computed(() => state.errors.get(commitsKey.value));
const commitsLoading = computed(() => !state.pullRequestCommits.value.has(commitsKey.value) && !commitsError.value);

const labelsKey = computed(() => repoLabelsKey(instanceId.value, owner.value, repo.value));
const assigneesKey = computed(() => repoAssigneesKey(instanceId.value, owner.value, repo.value));
const milestonesKey = computed(() => repoMilestonesKey(instanceId.value, owner.value, repo.value));
const subscriptionKey = computed(() => issueSubscriptionKey(instanceId.value, owner.value, repo.value, index.value));
const trackedTimesKey = computed(() => issueTrackedTimesKey(instanceId.value, owner.value, repo.value, index.value));
const stopwatchesKey = computed(() => userStopwatchesKey(instanceId.value));
const dependenciesKey = computed(() => issueDependenciesKey(instanceId.value, owner.value, repo.value, index.value));
const repoIssuesKeyValue = computed(() => repoIssuesKey(instanceId.value, owner.value, repo.value, 'open'));
const reactionsKey = computed(() => issueReactionsKey(instanceId.value, owner.value, repo.value, index.value));

const labels = computed(() => state.repoLabels.value.get(labelsKey.value) ?? []);
const assignees = computed(() => state.repoAssignees.value.get(assigneesKey.value) ?? []);
const milestones = computed(() => state.repoMilestones.value.get(milestonesKey.value) ?? []);
const subscription = computed(() => state.issueSubscriptions.value.get(subscriptionKey.value));
const trackedTimes = computed(() => state.issueTrackedTimes.value.get(trackedTimesKey.value) ?? []);
const stopwatches = computed(() => state.userStopwatches.value.get(stopwatchesKey.value) ?? []);
const isStopwatchRunning = computed(() =>
  stopwatches.value.some(
    (sw) => sw.repo_owner_name === owner.value && sw.repo_name === repo.value && sw.issue_index === index.value,
  ),
);
const dependencies = computed(() => state.issueDependencies.value.get(dependenciesKey.value) ?? []);
const repoIssues = computed(() => state.repoIssues.value.get(repoIssuesKeyValue.value) ?? []);
const repoIssuesLoading = computed(() => state.loading.get(repoIssuesKeyValue.value) ?? false);
const availableDependencies = computed(() =>
  repoIssues.value.filter(
    (issue) => issue.number !== index.value && !dependencies.value.some((dep) => dep.number === issue.number),
  ),
);
const reactions = computed(() => state.issueReactions.value.get(reactionsKey.value) ?? []);
const reactionsLoading = computed(() => state.loading.get(reactionsKey.value) ?? false);
const participants = computed(() => {
  const users = new Map<string, { login?: string; avatar_url?: string }>();
  if (detail.value?.user) {
    users.set(detail.value.user.login, detail.value.user);
  }
  for (const user of detail.value?.assignees ?? []) {
    if (user.login) {
      users.set(user.login, user);
    }
  }
  for (const comment of comments.value) {
    if (comment.user?.login) {
      users.set(comment.user.login, comment.user);
    }
  }
  return Array.from(users.values());
});
const prReference = computed(() => {
  const fullName = detail.value?.repository?.full_name ?? `${owner.value}/${repo.value}`;
  return `${fullName}#${detail.value?.number ?? index.value}`;
});

watch(
  [instanceId, owner, repo, index],
  () => {
    state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value);
    state.loadRepoLabels(instanceId.value, owner.value, repo.value);
    state.loadRepoAssignees(instanceId.value, owner.value, repo.value);
    state.loadRepoMilestones(instanceId.value, owner.value, repo.value);
    state.loadRepoIssues(instanceId.value, owner.value, repo.value, 'open');
    state.loadIssueSubscription(instanceId.value, owner.value, repo.value, index.value);
    state.loadIssueTrackedTimes(instanceId.value, owner.value, repo.value, index.value);
    state.loadUserStopwatches(instanceId.value);
    state.loadIssueDependencies(instanceId.value, owner.value, repo.value, index.value);
    state.loadIssueReactions(instanceId.value, owner.value, repo.value, index.value);
  },
  { immediate: true },
);

watch(
  () => detail.value,
  () => {
    if (detail.value) {
      state.loadPullRequestFiles(
        instanceId.value,
        owner.value,
        repo.value,
        index.value,
        detail.value.base?.sha,
        detail.value.head?.sha,
      );
      state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value);
      state.loadPullRequestCommits(instanceId.value, owner.value, repo.value, index.value);
    }
  },
  { immediate: true },
);

const prUrl = computed(() => detail.value?.html_url ?? '');
const isEditing = ref(false);
const uploadingAttachmentCount = ref(0);
const deletingAttachmentId = ref<number | undefined>(undefined);
const isDeletingAttachments = ref(false);
const pendingDeleteAttachmentIds = ref<number[]>([]);
const editFormKey = computed(() => pullRequestFormKey(instanceId.value, owner.value, repo.value, index.value));
const editLoading = computed(() => state.loading.get(editFormKey.value) ?? false);
const editError = computed(() => state.errors.get(editFormKey.value));
const formLoading = computed(() => editLoading.value || isDeletingAttachments.value);

const commentFormKey = computed(() => issueCommentFormKey(instanceId.value, owner.value, repo.value, index.value));
const commentLoading = computed(() => state.loading.get(commentFormKey.value) ?? false);
const commentError = computed(() => state.errors.get(commentFormKey.value));
const commentBody = ref('');
const pendingCommentAttachments = ref<File[]>([]);
const uploadingCommentAttachmentCount = ref(0);

const manualTimeHours = ref(0);
const manualTimeMinutes = ref(0);
const selectedDependencyNumber = ref<number | undefined>(undefined);
const isEditingDueDate = ref(false);
const dueDateValue = ref<string | undefined>(undefined);

function handleCommentAttachmentUpload(file: File) {
  pendingCommentAttachments.value.push(file);
}

function removePendingCommentAttachment(index: number) {
  pendingCommentAttachments.value.splice(index, 1);
}

async function handleCommentImageUpload(
  file: File,
  onSuccess: (url: string) => void,
  onError: (error: string) => void,
) {
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const url = attachment.uuid ? `/attachments/${attachment.uuid}` : (attachment.browser_download_url ?? '');
    if (!url) {
      onError('Failed to upload image');
      return;
    }
    onSuccess(url);
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

async function handleCommentSubmit() {
  const body = commentBody.value.trim();
  if (!body) {
    return;
  }
  try {
    const comment = await state.createIssueComment(instanceId.value, owner.value, repo.value, index.value, body);
    if (comment.id === undefined) {
      throw new Error('Created comment missing id');
    }
    const commentId = comment.id;
    const files = pendingCommentAttachments.value;
    if (files.length > 0) {
      await Promise.all(
        files.map(async (file) => {
          uploadingCommentAttachmentCount.value += 1;
          try {
            await state.uploadIssueCommentAttachment(
              instanceId.value,
              owner.value,
              repo.value,
              index.value,
              commentId,
              file,
            );
          } finally {
            uploadingCommentAttachmentCount.value -= 1;
          }
        }),
      );
    }
    commentBody.value = '';
    pendingCommentAttachments.value = [];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(commentFormKey.value, message);
  }
}

const mergeFormKey = computed(() => pullRequestMergeFormKey(instanceId.value, owner.value, repo.value, index.value));
const mergeLoading = computed(() => state.loading.get(mergeFormKey.value) ?? false);
const mergeError = computed(() => state.errors.get(mergeFormKey.value));
const mergeStrategy = ref<'merge' | 'rebase' | 'squash'>('merge');
const canMerge = computed(() => detail.value?.state === 'open' && !detail.value?.merged && canManagePullRequest.value);
const isMergeable = computed(() => detail.value?.mergeable === true);
const mergeBlockers = computed(() => detail.value?.mergeBlockers ?? []);
const hasMergeBlockers = computed(() => mergeBlockers.value.length > 0);

function blockerText(blocker: MergeBlocker): string {
  switch (blocker.type) {
    case 'required_approvals':
      return t('dashboard.detail.mergeableStatus.blocker.required_approvals', {
        count: blocker.requiredApprovals ?? 0,
      });
    case 'required_status_checks':
      return t('dashboard.detail.mergeableStatus.blocker.required_status_checks', {
        state: blocker.statusState ?? '-',
      });
    default:
      return t(`dashboard.detail.mergeableStatus.blocker.${blocker.type}`);
  }
}

const statusChecks = computed(() => detail.value?.statusChecks);
const hasStatusChecks = computed(() => (statusChecks.value?.statuses.length ?? 0) > 0);

function checkStatusIcon(status?: string): string {
  switch (status) {
    case 'success':
      return 'check';
    case 'pending':
      return 'watch';
    case 'failure':
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'question';
  }
}

function checkStatusClass(status?: string): string {
  return status ?? 'unknown';
}

function handleMerge() {
  if (!canMerge.value) {
    return;
  }
  state.mergePullRequest(instanceId.value, owner.value, repo.value, index.value, mergeStrategy.value);
}

const repoKey = computed(() => repoDetailKey(instanceId.value, owner.value, repo.value));
const repoDetail = computed(() => state.repoDetails.value.get(repoKey.value));
const branches = computed(() => repoDetail.value?.branches ?? []);

function openEdit() {
  state.loadRepoDetail(instanceId.value, owner.value, repo.value);
  state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value);
  isEditing.value = true;
}

function closeEdit() {
  pendingDeleteAttachmentIds.value = [];
  isEditing.value = false;
}

function handleEditSubmit(data: {
  title: string;
  body: string;
  base?: string;
  assignees: string[];
  labels: number[];
  milestone?: number;
  dueDate?: string;
}) {
  state.editPullRequest(instanceId.value, owner.value, repo.value, index.value, {
    title: data.title,
    body: data.body,
    base: data.base,
    assignees: data.assignees,
    labels: data.labels,
    milestone: data.milestone,
    dueDate: data.dueDate,
  });
}

async function deletePendingAttachments() {
  const ids = pendingDeleteAttachmentIds.value;
  if (ids.length === 0) {
    return;
  }
  isDeletingAttachments.value = true;
  deletingAttachmentId.value = ids[0];
  try {
    await Promise.all(
      ids.map((id) => state.deleteIssueAttachment(instanceId.value, owner.value, repo.value, index.value, id)),
    );
    const current = detail.value;
    if (current?.assets) {
      current.assets = current.assets.filter((a) => a.id === undefined || !ids.includes(a.id));
    }
  } finally {
    isDeletingAttachments.value = false;
    deletingAttachmentId.value = undefined;
  }
}

async function handleUploadImage(file: File, onSuccess: (url: string) => void, onError: (error: string) => void) {
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const current = detail.value;
    if (current) {
      if (!current.assets) {
        current.assets = [];
      }
      if (!current.assets.some((a) => a.uuid === attachment.uuid)) {
        current.assets.push(attachment);
      }
    }
    onSuccess(attachment.uuid ? `/attachments/${attachment.uuid}` : (attachment.browser_download_url ?? ''));
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}

async function handleAttachmentUpload(file: File) {
  uploadingAttachmentCount.value += 1;
  try {
    const attachment = await state.uploadIssueAttachment(instanceId.value, owner.value, repo.value, index.value, file);
    const current = detail.value;
    if (current) {
      if (!current.assets) {
        current.assets = [];
      }
      current.assets.push(attachment);
    }
  } finally {
    uploadingAttachmentCount.value -= 1;
  }
}

function handleAttachmentDelete(asset: ForgejoIssueAttachment) {
  const attachmentId = asset.id;
  if (attachmentId === undefined) {
    return;
  }
  const idx = pendingDeleteAttachmentIds.value.indexOf(attachmentId);
  if (idx >= 0) {
    pendingDeleteAttachmentIds.value.splice(idx, 1);
  } else {
    pendingDeleteAttachmentIds.value.push(attachmentId);
  }
}

function toggleState() {
  const nextState = detail.value?.state === 'open' ? 'closed' : 'open';
  state.editPullRequest(instanceId.value, owner.value, repo.value, index.value, { state: nextState });
}

function toggleSubscription() {
  const user = currentUsername.value;
  if (!user) {
    return;
  }
  const subscribe = !subscription.value?.subscribed;
  state.changeIssueSubscription(instanceId.value, owner.value, repo.value, index.value, user, subscribe);
}

function handleIssueReactionToggle(content: string, add: boolean) {
  state.changeIssueReaction(instanceId.value, owner.value, repo.value, index.value, content, add);
}

function addManualTime() {
  const hours = manualTimeHours.value || 0;
  const minutes = manualTimeMinutes.value || 0;
  const seconds = hours * 3600 + minutes * 60;
  if (seconds <= 0) {
    return;
  }
  state.addIssueTime(instanceId.value, owner.value, repo.value, index.value, seconds);
  manualTimeHours.value = 0;
  manualTimeMinutes.value = 0;
}

function addDependency() {
  const dependencyIndex = selectedDependencyNumber.value;
  if (dependencyIndex === undefined || dependencyIndex <= 0) {
    return;
  }
  state.createIssueDependency(instanceId.value, owner.value, repo.value, index.value, dependencyIndex);
  selectedDependencyNumber.value = undefined;
}

function startEditDueDate() {
  dueDateValue.value = detail.value?.due_date;
  isEditingDueDate.value = true;
}

function cancelEditDueDate() {
  isEditingDueDate.value = false;
  dueDateValue.value = undefined;
}

function saveDueDate() {
  state.editPullRequest(instanceId.value, owner.value, repo.value, index.value, {
    dueDate: dueDateValue.value || undefined,
  });
  isEditingDueDate.value = false;
  dueDateValue.value = undefined;
}

function clearDueDate() {
  state.editPullRequest(instanceId.value, owner.value, repo.value, index.value, {
    unsetDueDate: true,
  });
}

watch(
  () => state.lastSavedPullRequest.value,
  async (saved) => {
    if (
      saved?.instanceId === instanceId.value &&
      saved.owner === owner.value &&
      saved.repo === repo.value &&
      saved.index === index.value
    ) {
      try {
        await deletePendingAttachments();
        state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value, true);
        pendingDeleteAttachmentIds.value = [];
        isEditing.value = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.errors.set(editFormKey.value, t('dashboard.form.error', { message }));
      }
    }
  },
);

function handleOpenDiff(filename: string, status: string) {
  const baseSha = detail.value?.base?.sha;
  const headSha = detail.value?.head?.sha;
  if (!baseSha || !headSha) {
    return;
  }
  state.openPullRequestDiff(instanceId.value, owner.value, repo.value, index.value, filename, status, baseSha, headSha);
}

function handleOpenSelectedDiffs(selectedFiles: { filename: string; status: string }[]) {
  const baseSha = detail.value?.base?.sha;
  const headSha = detail.value?.head?.sha;
  if (!baseSha || !headSha || selectedFiles.length === 0) {
    return;
  }
  state.openSelectedPullRequestDiffs(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    selectedFiles,
    baseSha,
    headSha,
  );
}

function handleCommitOpenDiff(payload: { filename: string; status: string; baseSha: string; headSha: string }) {
  state.openPullRequestDiff(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    payload.filename,
    payload.status,
    payload.baseSha,
    payload.headSha,
  );
}

function handleCommitOpenSelectedDiffs(payload: {
  files: { filename: string; status: string }[];
  baseSha: string;
  headSha: string;
}) {
  if (payload.files.length === 0) {
    return;
  }
  state.openSelectedPullRequestDiffs(
    instanceId.value,
    owner.value,
    repo.value,
    index.value,
    payload.files,
    payload.baseSha,
    payload.headSha,
  );
}

const worktreeLoading = ref(false);
const worktreeStatus = ref('');
const worktreeStatusType = ref<'idle' | 'success' | 'error'>('idle');

const renderedBody = ref('');
const bodyLoading = ref(false);
const bodyError = ref('');

async function renderBody() {
  renderedBody.value = '';
  bodyError.value = '';
  if (!detail.value?.body) {
    return;
  }
  bodyLoading.value = true;
  try {
    const context = `${owner.value}/${repo.value}`;
    renderedBody.value = await state.renderMarkdown(instanceId.value, detail.value.body, context);
  } catch (error) {
    bodyError.value = error instanceof Error ? error.message : String(error);
  } finally {
    bodyLoading.value = false;
  }
}

watch(
  () => detail.value?.body,
  () => {
    renderBody();
  },
  { immediate: true },
);

function formatDate(date: string): string {
  try {
    const d = new Date(date);
    const now = Date.now();
    const diff = now - d.getTime();
    const minute = 60 * 1000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const month = 30 * day;
    const year = 365 * day;

    if (diff < minute) {
      return t('dashboard.timeAgo.justNow');
    }
    if (diff < hour) {
      return t('dashboard.timeAgo.minutes', { count: Math.floor(diff / minute) });
    }
    if (diff < day) {
      return t('dashboard.timeAgo.hours', { count: Math.floor(diff / hour) });
    }
    if (diff < month) {
      return t('dashboard.timeAgo.days', { count: Math.floor(diff / day) });
    }
    if (diff < year) {
      return t('dashboard.timeAgo.months', { count: Math.floor(diff / month) });
    }
    return t('dashboard.timeAgo.years', { count: Math.floor(diff / year) });
  } catch {
    return date;
  }
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(t('dashboard.detail.durationHours', { count: hours }));
  }
  if (minutes > 0 || (hours > 0 && secs > 0)) {
    parts.push(t('dashboard.detail.durationMinutes', { count: minutes }));
  }
  if (secs > 0 && hours === 0) {
    parts.push(t('dashboard.detail.durationSeconds', { count: secs }));
  }
  return parts.length > 0 ? parts.join(' ') : t('dashboard.detail.durationSeconds', { count: 0 });
}

function formatAbsoluteDate(date: string): string {
  try {
    return new Date(date).toLocaleDateString();
  } catch {
    return date;
  }
}

function labelStyle(color?: string): string {
  if (!color) {
    return '';
  }
  return `background-color: #${color}; color: ${isLightColor(color) ? '#000' : '#fff'};`;
}

function isLightColor(hex: string): boolean {
  const normalized = hex.replace('#', '');
  const r = parseInt(normalized.substring(0, 2), 16);
  const g = parseInt(normalized.substring(2, 4), 16);
  const b = parseInt(normalized.substring(4, 6), 16);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 128;
}

function prStateClass(state?: string, merged?: boolean): string {
  if (merged) {
    return 'state-merged';
  }
  if (state === 'closed') {
    return 'state-closed';
  }
  return 'state-open';
}

function prStateText(state?: string, merged?: boolean): string {
  if (merged) {
    return 'merged';
  }
  return state ?? 'open';
}

const hasWorktree = computed(() =>
  state.worktrees.value.some(
    (w) =>
      w.instanceId === instanceId.value &&
      w.owner === owner.value &&
      w.repo === repo.value &&
      w.prIndex === index.value,
  ),
);

function setWorktreeStatus(message: string, type: 'idle' | 'success' | 'error' = 'idle') {
  worktreeStatus.value = message;
  worktreeStatusType.value = type;
}

function openInWorktree() {
  worktreeLoading.value = true;
  setWorktreeStatus(t('dashboard.worktree.opening'), 'idle');
  state.openPrWorktree(instanceId.value, owner.value, repo.value, index.value);
}

watch(
  () => state.worktrees.value,
  () => {
    if (worktreeLoading.value) {
      worktreeLoading.value = false;
      setWorktreeStatus(t('dashboard.worktree.opened'), 'success');
    }
  },
  { deep: true },
);

watch(
  () => state.lastWorktreeCancelled.value,
  (cancelled) => {
    if (
      cancelled?.instanceId === instanceId.value &&
      cancelled.owner === owner.value &&
      cancelled.repo === repo.value &&
      cancelled.index === index.value
    ) {
      worktreeLoading.value = false;
      worktreeStatus.value = '';
      worktreeStatusType.value = 'idle';
    }
  },
);

watch(
  () => state.errors,
  () => {
    // No global error hook for worktree errors yet; status is updated via separate mechanism if needed.
  },
  { deep: true },
);

function reloadPullRequest() {
  state.loadPullRequestDetail(instanceId.value, owner.value, repo.value, index.value, true);
  state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value, true);
}
</script>

<template>
  <div class="pr-detail">
    <div v-if="loading" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error-state">
      <span>{{ t('dashboard.error', { message: error }) }}</span>
      <VscodeButton variant="secondary" icon="refresh" @click="reloadPullRequest">
        {{ t('dashboard.retry') }}
      </VscodeButton>
    </div>
    <div v-else-if="detail" class="detail-content">
      <div class="detail-main">
        <div class="detail-header">
          <h2 class="detail-title">
            <span class="detail-number">#{{ detail.number }}</span>
            {{ detail.title }}
          </h2>
          <div class="header-actions">
            <span class="state-badge" :class="prStateClass(detail.state, detail.merged)">
              {{ prStateText(detail.state, detail.merged) }}
            </span>
            <VscodeButton
              variant="icon"
              icon="link-external"
              :title="t('dashboard.detail.openPullRequest')"
              :aria-label="t('dashboard.detail.openPullRequest')"
              @click="state.openExternal(prUrl)"
            />
            <VscodeButton
              variant="icon"
              icon="copy"
              :title="t('dashboard.detail.copyLink')"
              :aria-label="t('dashboard.detail.copyLink')"
              @click="state.copyToClipboard(prUrl)"
            />
            <template v-if="canManagePullRequest">
              <VscodeButton
                variant="icon"
                icon="edit"
                :title="t('dashboard.actions.edit')"
                :aria-label="t('dashboard.actions.edit')"
                @click="openEdit"
              />
              <VscodeButton
                variant="icon"
                :icon="detail.state === 'open' ? 'close' : 'refresh'"
                :title="detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen')"
                :aria-label="detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen')"
                @click="toggleState"
              />
            </template>
          </div>
        </div>

        <div class="detail-meta">
          <img
            v-if="detail.user?.avatar_url"
            :src="detail.user.avatar_url"
            :alt="detail.user.login"
            class="user-avatar"
          />
          <vscode-icon
            v-else-if="detail.user"
            name="account"
            class="user-avatar avatar-fallback"
            :title="detail.user.login"
          />
          <span v-if="detail.user" class="user-name">{{ detail.user.login }}</span>
          <span v-if="detail.created_at" class="meta-item">{{ formatDate(detail.created_at) }}</span>
          <span v-if="detail.merged_at" class="meta-item">
            {{ t('dashboard.detail.mergedAt') }} {{ formatDate(detail.merged_at) }}
          </span>
        </div>

        <div v-if="detail.base || detail.head" class="detail-section">
          <h3>{{ t('dashboard.detail.branches') }}</h3>
          <div class="branch-info">
            <span class="branch-tag">{{ t('dashboard.detail.base') }}: {{ detail.base?.ref ?? '-' }}</span>
            <span class="branch-arrow">←</span>
            <span class="branch-tag">{{ t('dashboard.detail.head') }}: {{ detail.head?.ref ?? '-' }}</span>
          </div>
        </div>

        <div v-if="detail.additions !== undefined || detail.deletions !== undefined" class="detail-section">
          <h3>{{ t('dashboard.detail.changes') }}</h3>
          <div class="change-stats">
            <span class="additions">+{{ detail.additions ?? 0 }} {{ t('dashboard.detail.additions') }}</span>
            <span class="deletions">−{{ detail.deletions ?? 0 }} {{ t('dashboard.detail.deletions') }}</span>
            <span v-if="detail.changed_files" class="files">
              {{ detail.changed_files }} {{ t('dashboard.detail.changedFiles') }}
            </span>
          </div>
        </div>

        <div class="detail-section">
          <h3>{{ t('dashboard.detail.changedFilesTitle') }}</h3>
          <DiffFileList
            :files="files"
            :loading="filesLoading"
            :error="filesError"
            :supports-multi-diff="state.supportsMultiDiff.value"
            @open-diff="handleOpenDiff"
            @open-selected-diffs="handleOpenSelectedDiffs"
          />
        </div>

        <div class="detail-section">
          <h3>{{ t('dashboard.detail.commits') }}</h3>
          <div v-if="commitsLoading" class="loading">
            <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
          </div>
          <div v-else-if="commitsError" class="error">{{ t('dashboard.error', { message: commitsError }) }}</div>
          <CommitDiffList
            v-else
            :commits="commits"
            :supports-multi-diff="state.supportsMultiDiff.value"
            @open-diff="handleCommitOpenDiff"
            @open-selected-diffs="handleCommitOpenSelectedDiffs"
          />
        </div>

        <div class="detail-section">
          <h3>{{ t('dashboard.detail.body') }}</h3>
          <MarkdownBody
            :html="renderedBody"
            :loading="bodyLoading"
            :error="bodyError"
            :base-url="baseUrl"
            @open-external="state.openExternal($event)"
          />
          <ReactionBar
            class="issue-reactions"
            :reactions="reactions"
            :current-username="currentUsername"
            :loading="reactionsLoading"
            @toggle="handleIssueReactionToggle"
          />
        </div>

        <AttachmentList :assets="detail.assets" @open-external="state.openExternal($event)" />

        <div v-if="detail.merged_by" class="detail-section">
          <h3>{{ t('dashboard.detail.mergedBy') }}</h3>
          <div class="detail-meta">
            <img
              v-if="detail.merged_by?.avatar_url"
              :src="detail.merged_by.avatar_url"
              :alt="detail.merged_by.login"
              class="user-avatar"
            />
            <span class="user-name">{{ detail.merged_by.login }}</span>
          </div>
        </div>

        <div class="detail-section">
          <h3>{{ t('dashboard.detail.commentsAndTimeline') }}</h3>
          <div v-if="commentsLoading" class="loading">
            <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
          </div>
          <div v-else-if="commentsError" class="error">{{ t('dashboard.error', { message: commentsError }) }}</div>
          <CommentTimeline
            v-else
            :comments="comments"
            :instance-id="instanceId"
            :owner="owner"
            :repo="repo"
            :index="index"
            :base-url="baseUrl"
          />

          <div class="comment-form">
            <EasyMdeEditor
              v-model="commentBody"
              :placeholder="t('dashboard.detail.addCommentPlaceholder')"
              :disabled="commentLoading"
              :upload-image="handleCommentImageUpload"
            />
            <AttachmentList
              :assets="[]"
              :allow-upload="true"
              :allow-delete="false"
              :uploading="uploadingCommentAttachmentCount > 0"
              @upload="handleCommentAttachmentUpload($event)"
            />
            <PendingAttachmentList
              :files="pendingCommentAttachments"
              @remove="removePendingCommentAttachment($event)"
            />
            <div class="comment-form-actions">
              <VscodeButton
                variant="primary"
                :disabled="!commentBody.trim() || commentLoading || uploadingCommentAttachmentCount > 0"
                @click="handleCommentSubmit"
              >
                {{
                  commentLoading || uploadingCommentAttachmentCount > 0
                    ? t('dashboard.form.saving')
                    : t('dashboard.detail.postComment')
                }}
              </VscodeButton>
            </div>
            <div v-if="commentError" class="error">{{ t('dashboard.error', { message: commentError }) }}</div>
          </div>
        </div>

        <div class="actions">
          <button type="button" class="action-link link-button" @click="state.openExternal(prUrl)">
            {{ t('dashboard.detail.openPullRequest') }}
          </button>
          <button type="button" class="action-link link-button" @click="state.copyToClipboard(prUrl)">
            {{ t('dashboard.detail.copyLink') }}
          </button>
          <button
            type="button"
            class="action-link link-button"
            :class="{ disabled: worktreeLoading }"
            :disabled="worktreeLoading"
            @click="openInWorktree"
          >
            {{
              worktreeLoading
                ? t('dashboard.worktree.opening')
                : hasWorktree
                  ? t('dashboard.worktree.openExisting')
                  : t('dashboard.worktree.openInWorktree')
            }}
          </button>
        </div>

        <div v-if="hasStatusChecks" class="checks-section">
          <h3>{{ t('dashboard.detail.checks') }}</h3>
          <div class="checks-summary">
            <vscode-icon
              :class="['check-icon', checkStatusClass(statusChecks?.state)]"
              :name="checkStatusIcon(statusChecks?.state)"
            />
            <span>{{ t(`dashboard.detail.checksState.${statusChecks?.state ?? 'unknown'}`) }}</span>
          </div>
          <div class="checks-list">
            <div v-for="check in statusChecks?.statuses" :key="check.id ?? check.context" class="check-item">
              <a
                v-if="check.target_url"
                class="check-row link-button"
                :href="check.target_url"
                @click.prevent="state.openExternal(check.target_url)"
              >
                <vscode-icon
                  :class="['check-icon', checkStatusClass(check.status)]"
                  :name="checkStatusIcon(check.status)"
                />
                <span class="check-context">{{ check.context }}</span>
              </a>
              <div v-else class="check-row">
                <vscode-icon
                  :class="['check-icon', checkStatusClass(check.status)]"
                  :name="checkStatusIcon(check.status)"
                />
                <span class="check-context">{{ check.context }}</span>
              </div>
              <span v-if="check.description" class="check-description">{{ check.description }}</span>
            </div>
          </div>
        </div>

        <div v-if="canMerge" class="merge-section">
          <h3>{{ t('dashboard.detail.mergePullRequest') }}</h3>
          <div class="merge-status-list">
            <div v-if="!hasMergeBlockers && isMergeable" class="merge-status mergeable">
              <vscode-icon name="check" />
              <span>{{ t('dashboard.detail.mergeableStatus.mergeable') }}</span>
            </div>
            <div
              v-for="(blocker, blockerIndex) in mergeBlockers"
              :key="blockerIndex"
              :class="['merge-status', 'blocked', blocker.type]"
            >
              <vscode-icon :name="blocker.type === 'conflicts' ? 'warning' : 'error'" />
              <span>{{ blockerText(blocker) }}</span>
            </div>
            <div v-if="!hasMergeBlockers && !isMergeable" class="merge-status unknown">
              <vscode-icon name="question" />
              <span>{{ t('dashboard.detail.mergeableStatus.unknown') }}</span>
            </div>
          </div>
          <div class="merge-form">
            <vscode-select v-model="mergeStrategy">
              <vscode-option value="merge">{{ t('dashboard.detail.mergeStrategy.merge') }}</vscode-option>
              <vscode-option value="squash">{{ t('dashboard.detail.mergeStrategy.squash') }}</vscode-option>
              <vscode-option value="rebase">{{ t('dashboard.detail.mergeStrategy.rebase') }}</vscode-option>
            </vscode-select>
            <vscode-button :disabled="mergeLoading || !isMergeable || hasMergeBlockers" @click="handleMerge">
              {{ mergeLoading ? t('dashboard.detail.merging') : t('dashboard.detail.merge') }}
            </vscode-button>
          </div>
          <div v-if="mergeError" class="error">{{ t('dashboard.error', { message: mergeError }) }}</div>
        </div>

        <div v-if="worktreeStatus" :class="['worktree-status', worktreeStatusType]">{{ worktreeStatus }}</div>
      </div>

      <div class="detail-sidebar">
        <CollapsibleSection v-if="detail.labels?.length" :title="t('dashboard.detail.labels')">
          <div class="label-list">
            <span
              v-for="label in detail.labels"
              :key="label.name ?? ''"
              class="label-tag"
              :style="labelStyle(label.color)"
            >
              {{ label.name }}
            </span>
          </div>
        </CollapsibleSection>

        <CollapsibleSection v-if="detail.milestone" :title="t('dashboard.detail.milestone')">
          <span class="milestone-tag">{{ detail.milestone.title }}</span>
        </CollapsibleSection>

        <CollapsibleSection v-if="detail.assignees?.length" :title="t('dashboard.detail.assignees')">
          <div class="assignee-list">
            <div v-for="user in detail.assignees" :key="user.login" class="assignee-item">
              <img v-if="user.avatar_url" :src="user.avatar_url" :alt="user.login" class="user-avatar-small" />
              <vscode-icon v-else name="account" class="user-avatar-small avatar-fallback" />
              <span class="assignee-name">{{ user.login }}</span>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.dueDate')">
          <div v-if="isEditingDueDate" class="due-date-edit">
            <VscodeDateField v-model="dueDateValue" />
            <div class="due-date-edit-actions">
              <button type="button" class="link-button" :title="t('dashboard.actions.save')" @click="saveDueDate">
                <vscode-icon name="check" />
              </button>
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.cancel')"
                @click="cancelEditDueDate"
              >
                <vscode-icon name="close" />
              </button>
            </div>
          </div>
          <div v-else class="due-date-row">
            <template v-if="detail.due_date">
              <vscode-icon name="calendar" />
              <span class="due-date">{{ formatAbsoluteDate(detail.due_date) }}</span>
              <button
                v-if="canManagePullRequest"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.edit')"
                @click="startEditDueDate"
              >
                <vscode-icon name="edit" />
              </button>
              <button
                v-if="canManagePullRequest"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                @click="clearDueDate"
              >
                <vscode-icon name="trash" />
              </button>
            </template>
            <template v-else>
              <span class="due-date-empty">{{ t('dashboard.detail.noDueDate') }}</span>
              <button
                v-if="canManagePullRequest"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.set')"
                @click="startEditDueDate"
              >
                <vscode-icon name="edit" />
              </button>
            </template>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.participants', { count: participants.length })">
          <div class="participant-list">
            <template v-for="user in participants" :key="user.login">
              <img
                v-if="user.avatar_url"
                :src="user.avatar_url"
                :alt="user.login"
                class="user-avatar-small"
                :title="user.login"
              />
              <vscode-icon v-else name="account" class="user-avatar-small avatar-fallback" :title="user.login" />
            </template>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.references')">
          <div class="reference-row">
            <span class="reference-text">{{ prReference }}</span>
            <button
              type="button"
              class="link-button"
              :title="t('dashboard.actions.copyUrl')"
              @click="state.copyToClipboard(prReference)"
            >
              <vscode-icon name="copy" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.subscription')">
          <div v-if="subscription === undefined" class="loading-inline">{{ t('dashboard.loading') }}</div>
          <div v-else class="subscription-actions">
            <VscodeButton
              variant="secondary"
              :icon="subscription.subscribed ? 'bell-slash' : 'bell'"
              @click="toggleSubscription"
            >
              {{ subscription.subscribed ? t('dashboard.detail.unsubscribe') : t('dashboard.detail.subscribe') }}
            </VscodeButton>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.timeTracking')">
          <div class="time-tracking-summary">
            <span class="tracked-time">{{
              formatDuration(trackedTimes.reduce((sum, t) => sum + (t.time ?? 0), 0))
            }}</span>
          </div>
          <div class="time-tracking-actions">
            <VscodeButton
              v-if="!isStopwatchRunning"
              variant="secondary"
              icon="play"
              @click="state.startIssueStopwatch(instanceId, owner, repo, index)"
            >
              {{ t('dashboard.detail.startStopwatch') }}
            </VscodeButton>
            <VscodeButton
              v-else
              variant="secondary"
              icon="debug-pause"
              @click="state.stopIssueStopwatch(instanceId, owner, repo, index)"
            >
              {{ t('dashboard.detail.stopStopwatch') }}
            </VscodeButton>
          </div>
          <div class="time-tracking-form">
            <vscode-textfield
              type="number"
              :value="String(manualTimeHours)"
              min="0"
              @input="manualTimeHours = Number(($event.target as HTMLInputElement).value)"
            />
            <span>{{ t('dashboard.detail.hours') }}</span>
            <vscode-textfield
              type="number"
              :value="String(manualTimeMinutes)"
              min="0"
              max="59"
              @input="manualTimeMinutes = Number(($event.target as HTMLInputElement).value)"
            />
            <span>{{ t('dashboard.detail.minutes') }}</span>
            <VscodeButton variant="secondary" icon="add" @click="addManualTime">
              {{ t('dashboard.detail.addTime') }}
            </VscodeButton>
          </div>
          <div v-if="trackedTimes.length" class="tracked-time-list">
            <div v-for="time in trackedTimes" :key="time.id" class="tracked-time-item">
              <span>{{ formatDuration(time.time ?? 0) }}</span>
              <span v-if="time.user_name" class="tracked-time-user">{{ time.user_name }}</span>
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                @click="state.deleteIssueTime(instanceId, owner, repo, index, time.id ?? 0)"
              >
                <vscode-icon name="trash" />
              </button>
            </div>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.dependencies')">
          <div v-if="dependencies.length" class="dependency-list">
            <div v-for="dep in dependencies" :key="dep.id" class="dependency-item">
              <button
                type="button"
                class="link-button"
                @click="state.openIssueDetail(instanceId, owner, repo, dep.number)"
              >
                #{{ dep.number }} {{ dep.title }}
              </button>
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                @click="state.removeIssueDependency(instanceId, owner, repo, index, dep.number)"
              >
                <vscode-icon name="trash" />
              </button>
            </div>
          </div>
          <div v-else class="empty-list">{{ t('dashboard.detail.noDependencies') }}</div>
          <div class="dependency-form">
            <div v-if="repoIssuesLoading" class="dependency-status">{{ t('dashboard.detail.dependencyLoading') }}</div>
            <template v-else>
              <select
                :value="selectedDependencyNumber === undefined ? '' : String(selectedDependencyNumber)"
                class="dependency-select"
                @change="selectedDependencyNumber = Number(($event.target as HTMLSelectElement).value) || undefined"
              >
                <option value="">{{ t('dashboard.detail.dependencyPlaceholder') }}</option>
                <option v-for="issue in availableDependencies" :key="issue.id" :value="String(issue.number)">
                  #{{ issue.number }} {{ issue.title }}
                </option>
              </select>
              <VscodeButton
                variant="secondary"
                icon="add"
                :disabled="!selectedDependencyNumber || availableDependencies.length === 0"
                @click="addDependency"
              >
                {{ t('dashboard.detail.addDependency') }}
              </VscodeButton>
            </template>
          </div>
          <div v-if="!repoIssuesLoading && availableDependencies.length === 0" class="dependency-status empty">
            {{ t('dashboard.detail.dependencyEmpty') }}
          </div>
        </CollapsibleSection>
      </div>

      <ModalDialog
        :open="isEditing"
        :title="t('dashboard.form.editPullRequest')"
        :loading="formLoading"
        @close="closeEdit"
      >
        <PullRequestForm
          mode="edit"
          :initial-title="detail.title"
          :initial-body="detail.body"
          :initial-base="detail.base?.ref"
          :initial-head="detail.head?.ref"
          :initial-label-ids="
            (detail.labels ?? []).map((label) => label.id).filter((id): id is number => id !== undefined)
          "
          :initial-assignees="(detail.assignees ?? []).map((user) => user.login ?? '').filter(Boolean)"
          :initial-milestone-id="detail.milestone?.id"
          :initial-due-date="detail.due_date"
          :branches="branches"
          :labels="labels"
          :assignees="assignees"
          :milestones="milestones"
          :submit-label="t('dashboard.form.save')"
          :loading="formLoading"
          :error="editError"
          :upload-image="handleUploadImage"
          @submit="handleEditSubmit"
          @cancel="closeEdit"
        >
          <template #extra>
            <AttachmentList
              :assets="detail.assets"
              :allow-upload="true"
              :allow-delete="true"
              :uploading="uploadingAttachmentCount > 0"
              :deleting-id="deletingAttachmentId"
              :pending-delete-ids="pendingDeleteAttachmentIds"
              @open-external="state.openExternal($event)"
              @upload="handleAttachmentUpload"
              @delete="handleAttachmentDelete"
            />
          </template>
        </PullRequestForm>
      </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
.pr-detail {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: auto;
}

.loading-state,
.error-state {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vscode-descriptionForeground);
}

.error-state {
  flex-wrap: wrap;
}

.detail-content {
  display: grid;
  grid-template-columns: 1fr 280px;
  gap: 24px;
  align-items: start;
}

@media (max-width: 720px) {
  .detail-content {
    grid-template-columns: 1fr;
  }
}

.detail-main {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.detail-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0;
  position: sticky;
  top: 0;
  max-height: 100%;
  overflow-x: hidden;
  overflow-y: auto;
}

.detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.detail-title {
  margin: 0;
  font-size: 1.1rem;
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-number {
  color: var(--vscode-descriptionForeground);
  font-weight: 400;
}

.header-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
}

.state-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
  font-weight: 600;
  text-transform: capitalize;
}

.state-open {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
}

.state-closed {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
}

.state-merged {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  border: 1px solid var(--vscode-gitDecoration-addedResourceForeground, #8957e5);
}

.detail-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
}

.user-avatar {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.user-avatar.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.user-name {
  color: var(--vscode-foreground);
  font-weight: 500;
}

.meta-item {
  color: var(--vscode-descriptionForeground);
}

.detail-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.detail-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.branch-info {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.branch-tag {
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
}

.branch-arrow {
  color: var(--vscode-descriptionForeground);
}

.change-stats {
  display: flex;
  gap: 12px;
  font-size: 0.9em;
}

.additions {
  color: var(--vscode-gitDecoration-addedResourceForeground, #28a745);
}

.deletions {
  color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
}

.files {
  color: var(--vscode-descriptionForeground);
}

.label-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.label-tag {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
}

.milestone-tag {
  display: inline-block;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.85em;
}

.body-content {
  white-space: pre-wrap;
  font-family: var(--vscode-editor-font-family), monospace;
  font-size: 0.9em;
  line-height: 1.5;
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
  color: var(--vscode-foreground);
}

.detail-section .markdown-content {
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  padding: 12px;
  border-radius: 4px;
}

.detail-section .markdown-loading,
.detail-section .markdown-empty,
.detail-section .markdown-error {
  padding: 12px;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
  border-radius: 4px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  margin-top: 8px;
}

.action-link {
  color: var(--vscode-textLink-foreground);
  text-decoration: none;
  font-size: 0.9em;
  white-space: nowrap;
}

.action-link:hover {
  text-decoration: underline;
}

.action-link.disabled {
  color: var(--vscode-descriptionForeground);
  pointer-events: none;
  text-decoration: none;
}

.worktree-status {
  padding: 8px 12px;
  border-radius: 4px;
  font-size: 0.9em;
  background-color: var(--vscode-editor-inactiveSelectionBackground);
}

.worktree-status.success {
  color: var(--vscode-testing-iconPassed);
}

.worktree-status.error {
  color: var(--vscode-testing-iconFailed);
}

.detail-loading-ring {
  width: 16px;
  height: 16px;
  vertical-align: middle;
}

.comment-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.comment-form-actions {
  display: flex;
  justify-content: flex-end;
}

.merge-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.merge-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.merge-form {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.merge-status-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.merge-status {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
}

.merge-status.mergeable {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.merge-status.blocked {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-conflictingResourceForeground));
}

.merge-status.blocked.conflicts {
  color: var(--vscode-editorWarning-foreground, var(--vscode-gitDecoration-conflictingResourceForeground));
}

.merge-status.unknown {
  color: var(--vscode-descriptionForeground);
}

.checks-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.checks-section h3 {
  margin: 0;
  font-size: 0.95rem;
  color: var(--vscode-foreground);
}

.checks-summary {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
  font-weight: 600;
}

.checks-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.check-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.check-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.9em;
}

.check-icon {
  flex-shrink: 0;
}

.check-icon.success {
  color: var(--vscode-testing-iconPassed, var(--vscode-gitDecoration-addedResourceForeground));
}

.check-icon.pending {
  color: var(--vscode-descriptionForeground);
}

.check-icon.failure,
.check-icon.error {
  color: var(--vscode-testing-iconFailed, var(--vscode-gitDecoration-deletedResourceForeground));
}

.check-icon.warning {
  color: var(--vscode-editorWarning-foreground, var(--vscode-gitDecoration-untrackedResourceForeground));
}

.check-icon.unknown {
  color: var(--vscode-descriptionForeground);
}

.check-context {
  color: var(--vscode-foreground);
}

.check-description {
  font-size: 0.85em;
  color: var(--vscode-descriptionForeground);
  margin-left: 22px;
}

.loading-inline {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.subscription-actions {
  display: flex;
  gap: 8px;
}

.time-tracking-summary {
  font-size: 1.1em;
  font-weight: 600;
  margin-bottom: 8px;
}

.time-tracking-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
}

.time-tracking-form {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.time-tracking-form vscode-textfield {
  width: 60px;
}

.tracked-time-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tracked-time-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.tracked-time-user {
  color: var(--vscode-descriptionForeground);
}

.dependency-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 12px;
}

.dependency-item {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dependency-form {
  display: flex;
  align-items: center;
  gap: 8px;
}

.dependency-form vscode-textfield {
  flex: 1;
}

.dependency-select {
  flex: 1;
  min-width: 0;
  padding: 4px 8px;
  background-color: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  border-radius: 2px;
  font-size: 0.9em;
}

.dependency-status {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.dependency-status.empty {
  margin-top: 8px;
}

.assignee-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.assignee-item {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.user-avatar-small {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.user-avatar-small.avatar-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
}

.due-date {
  font-size: 0.9em;
  color: var(--vscode-foreground);
}

.due-date-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.due-date-empty {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
}

.due-date-edit {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.due-date-edit-actions {
  display: flex;
  gap: 8px;
}

.participant-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.reference-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.9em;
}

.reference-text {
  font-family: var(--vscode-editor-font-family), monospace;
  color: var(--vscode-foreground);
  word-break: break-all;
}

.issue-reactions {
  margin-top: 12px;
}

.empty-list {
  color: var(--vscode-descriptionForeground);
  font-size: 0.9em;
  margin-bottom: 12px;
}
</style>
