<script setup lang="ts">
import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { CollapsibleSection } from '../vscode-controls';
import DateTimePicker from '../components/DateTimePicker.vue';
import MarkdownBody from '../components/MarkdownBody.vue';
import ReactionBar from '../components/ReactionBar.vue';
import AttachmentList from '../components/AttachmentList.vue';
import PendingAttachmentList from '../components/PendingAttachmentList.vue';
import CommentTimeline from '../components/CommentTimeline.vue';
import ModalDialog from '../components/ModalDialog.vue';
import IssueForm from '../components/IssueForm.vue';
import EasyMdeEditor from '../components/EasyMdeEditor.vue';
import { stateLabel } from '../utils/stateLabel';
import {
  useAppState,
  issueDetailKey,
  issueFormKey,
  issueCommentFormKey,
  pullRequestCommentsKey,
  repoLabelsKey,
  repoAssigneesKey,
  repoMilestonesKey,
  repoIssuesKey,
  issueSubscriptionKey,
  issueTrackedTimesKey,
  userStopwatchesKey,
  issueDependenciesKey,
  issueReactionsKey,
  issueStateKey,
  issueDueDateKey,
  startWorkKey,
} from '../composables/useAppState';
import type { ForgejoIssueAttachment } from '../types/api';

const { t } = useI18n();
const route = useRoute();
const state = useAppState();

const instanceId = computed(() => String(route.params.instanceId));
const owner = computed(() => String(route.params.owner));
const repo = computed(() => String(route.params.repo));
const index = computed(() => Number(route.params.index));
const key = computed(() => issueDetailKey(instanceId.value, owner.value, repo.value, index.value));

const detail = computed(() => state.issueDetails.value.get(key.value));
const loading = computed(() => state.loading.get(key.value) ?? false);
const error = computed(() => state.errors.get(key.value));
const baseUrl = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.url);
const currentUsername = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.username);
const isIssueAuthor = computed(
  () => detail.value?.user?.login === currentUsername.value && currentUsername.value !== undefined,
);
const canManageIssue = computed(() => {
  if (isIssueAuthor.value) {
    return true;
  }
  const permissions = detail.value?.repoPermissions;
  return permissions?.admin === true || permissions?.push === true;
});

const commentsKey = computed(() => pullRequestCommentsKey(instanceId.value, owner.value, repo.value, index.value));
const comments = computed(() => state.pullRequestComments.value.get(commentsKey.value) ?? []);
const commentsError = computed(() => state.errors.get(commentsKey.value));
const commentsLoading = computed(() => !state.pullRequestComments.value.has(commentsKey.value) && !commentsError.value);

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
const issueReference = computed(() => {
  const fullName = detail.value?.repository?.full_name ?? `${owner.value}/${repo.value}`;
  return `${fullName}#${detail.value?.number ?? index.value}`;
});

// Under keep-alive this view is deactivated (not unmounted) when navigating
// away; `route.params` then tracks the global route, not this view's own
// route. Guard all route-driven loading on isActive.
const isActive = ref(true);

function loadIssueData() {
  state.loadIssueDetail(instanceId.value, owner.value, repo.value, index.value);
  state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value);
  state.loadRepoLabels(instanceId.value, owner.value, repo.value);
  state.loadRepoAssignees(instanceId.value, owner.value, repo.value);
  state.loadRepoMilestones(instanceId.value, owner.value, repo.value);
  state.loadRepoIssues(instanceId.value, owner.value, repo.value, 'open');
  state.loadIssueSubscription(instanceId.value, owner.value, repo.value, index.value);
  state.loadIssueTrackedTimes(instanceId.value, owner.value, repo.value, index.value);
  state.loadUserStopwatches(instanceId.value);
  state.loadIssueDependencies(instanceId.value, owner.value, repo.value, index.value);
  state.loadIssueReactions(instanceId.value, owner.value, repo.value, index.value);
}

onActivated(() => {
  isActive.value = true;
  // Params may have changed back before this hook ran; make sure data for the
  // current route is loaded (loaders dedup via their caches).
  loadIssueData();
  renderBody();
});
onDeactivated(() => {
  isActive.value = false;
});

watch(
  [instanceId, owner, repo, index],
  () => {
    if (!isActive.value) {
      return;
    }
    loadIssueData();
  },
  { immediate: true },
);

const renderedBody = ref('');
const bodyLoading = ref(false);
const bodyError = ref('');

// Last-request-wins guard: consecutive body changes trigger concurrent
// renderMarkdown calls; only the latest request may write back.
let renderBodyToken = 0;

async function renderBody() {
  const token = ++renderBodyToken;
  renderedBody.value = '';
  bodyError.value = '';
  if (!detail.value?.body) {
    return;
  }
  bodyLoading.value = true;
  try {
    const context = `${owner.value}/${repo.value}`;
    const html = await state.renderMarkdown(instanceId.value, detail.value.body, context);
    if (token === renderBodyToken) {
      renderedBody.value = html;
    }
  } catch (error) {
    if (token === renderBodyToken) {
      bodyError.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    if (token === renderBodyToken) {
      bodyLoading.value = false;
    }
  }
}

watch(
  () => detail.value?.body,
  () => {
    if (!isActive.value) {
      return;
    }
    renderBody();
  },
  { immediate: true },
);

const issueUrl = computed(() => detail.value?.html_url ?? '');
const isEditing = ref(false);
const editFormDirty = ref(false);
const uploadingAttachmentCount = ref(0);
const deletingAttachmentId = ref<number | undefined>(undefined);
const isDeletingAttachments = ref(false);
const pendingDeleteAttachmentIds = ref<number[]>([]);
const editFormKey = computed(() => issueFormKey(instanceId.value, owner.value, repo.value, index.value));
const editLoading = computed(() => state.loading.get(editFormKey.value) ?? false);
const editError = computed(() => state.errors.get(editFormKey.value));
const formLoading = computed(() => editLoading.value || isDeletingAttachments.value);

const commentFormKey = computed(() => issueCommentFormKey(instanceId.value, owner.value, repo.value, index.value));
const commentLoading = computed(() => state.loading.get(commentFormKey.value) ?? false);
const commentError = computed(() => state.errors.get(commentFormKey.value));
const commentBody = ref('');
const pendingCommentAttachments = ref<File[]>([]);
const uploadingCommentAttachmentCount = ref(0);

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

function openEdit() {
  state.loadIssueDetail(instanceId.value, owner.value, repo.value, index.value);
  isEditing.value = true;
}

function closeEdit() {
  pendingDeleteAttachmentIds.value = [];
  isEditing.value = false;
}

function handleEditSubmit(data: {
  title: string;
  body: string;
  labels: number[];
  assignees: string[];
  milestone?: number;
  dueDate?: string;
}) {
  state.editIssue(instanceId.value, owner.value, repo.value, index.value, {
    title: data.title,
    body: data.body,
    labels: data.labels,
    assignees: data.assignees,
    milestone: data.milestone,
    dueDate: data.dueDate,
  });
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

const manualTimeHours = ref(0);
const manualTimeMinutes = ref(0);
const selectedDependencyNumber = ref<number | undefined>(undefined);
const isEditingDueDate = ref(false);
const dueDateValue = ref<string | null>(null);

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
  dueDateValue.value = detail.value?.due_date ?? null;
  state.errors.delete(dueDateKey.value);
  isEditingDueDate.value = true;
}

function cancelEditDueDate() {
  isEditingDueDate.value = false;
  dueDateValue.value = null;
  state.errors.delete(dueDateKey.value);
}

// The inline due-date save reports against its own key (see stateToggleKey):
// the editor stays open while saving, closes on success, and shows the error
// next to itself on failure instead of losing it in the edit form's key.
const dueDateKey = computed(() => issueDueDateKey(instanceId.value, owner.value, repo.value, index.value));
const dueDateError = computed(() => state.errors.get(dueDateKey.value));
const dueDateSaving = computed(() => state.loading.get(dueDateKey.value) ?? false);

watch(dueDateSaving, (saving, wasSaving) => {
  if (wasSaving && !saving && !dueDateError.value) {
    isEditingDueDate.value = false;
    dueDateValue.value = null;
  }
});

function saveDueDate() {
  state.updateIssueDueDate(instanceId.value, owner.value, repo.value, index.value, {
    dueDate: dueDateValue.value || undefined,
  });
}

function clearDueDate() {
  state.updateIssueDueDate(instanceId.value, owner.value, repo.value, index.value, {
    unsetDueDate: true,
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
  } catch (error) {
    // Surface the failure in the edit dialog instead of swallowing it.
    const message = error instanceof Error ? error.message : String(error);
    state.errors.set(editFormKey.value, t('dashboard.form.error', { message }));
  } finally {
    uploadingAttachmentCount.value -= 1;
  }
}

function handleAttachmentDelete(asset: ForgejoIssueAttachment) {
  const attachmentId = asset.id;
  if (attachmentId === undefined) {
    return;
  }
  const index = pendingDeleteAttachmentIds.value.indexOf(attachmentId);
  if (index >= 0) {
    pendingDeleteAttachmentIds.value.splice(index, 1);
  } else {
    pendingDeleteAttachmentIds.value.push(attachmentId);
  }
}

function toggleState() {
  const nextState = detail.value?.state === 'open' ? 'closed' : 'open';
  state.toggleIssueState(instanceId.value, owner.value, repo.value, index.value, nextState);
}

// Close/reopen reports against its own key: the error renders next to the
// button instead of disappearing into the edit form's key.
const stateToggleKey = computed(() => issueStateKey(instanceId.value, owner.value, repo.value, index.value));
const stateToggleError = computed(() => state.errors.get(stateToggleKey.value));
const stateToggleLoading = computed(() => state.loading.get(stateToggleKey.value) ?? false);

// Start-work runs the worktree pipeline on the host (possibly with quick
// picks), so it can take a while; the error renders next to the button.
const startWorkLoadingKey = computed(() => startWorkKey(instanceId.value, owner.value, repo.value, index.value));
const startWorkError = computed(() => state.errors.get(startWorkLoadingKey.value));
const startWorkLoading = computed(() => state.loading.get(startWorkLoadingKey.value) ?? false);

function handleStartWork() {
  state.startWorkOnIssue(instanceId.value, owner.value, repo.value, index.value, detail.value?.title);
}

async function handleDeleteIssue() {
  const confirmed = await state.showConfirm(
    t('dashboard.detail.deleteIssueConfirm', { number: detail.value?.number ?? index.value }),
  );
  if (!confirmed) {
    return;
  }
  state.deleteIssue(instanceId.value, owner.value, repo.value, index.value);
}

async function handleDeleteTime(timeId: number) {
  const confirmed = await state.showConfirm(t('dashboard.detail.deleteTimeConfirm'));
  if (!confirmed) {
    return;
  }
  state.deleteIssueTime(instanceId.value, owner.value, repo.value, index.value, timeId);
}

async function handleRemoveDependency(depNumber: number) {
  const confirmed = await state.showConfirm(t('dashboard.detail.removeDependencyConfirm', { number: depNumber }));
  if (!confirmed) {
    return;
  }
  state.removeIssueDependency(instanceId.value, owner.value, repo.value, index.value, depNumber);
}

watch(
  () => state.lastSavedIssue.value,
  async (saved) => {
    if (
      saved?.instanceId === instanceId.value &&
      saved.owner === owner.value &&
      saved.repo === repo.value &&
      saved.index === index.value
    ) {
      try {
        await deletePendingAttachments();
        state.loadIssueDetail(instanceId.value, owner.value, repo.value, index.value, true);
        pendingDeleteAttachmentIds.value = [];
        isEditing.value = false;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.errors.set(editFormKey.value, t('dashboard.form.error', { message }));
      }
    }
  },
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
  const r = parseInt(normalized.substring(0, 2), 16) / 255;
  const g = parseInt(normalized.substring(2, 4), 16) / 255;
  const b = parseInt(normalized.substring(4, 6), 16) / 255;
  const luminance = 0.2126 * channelLuminance(r) + 0.7152 * channelLuminance(g) + 0.0722 * channelLuminance(b);
  return luminance > 0.5;
}

function channelLuminance(channel: number): number {
  return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

function reloadIssue() {
  state.loadIssueDetail(instanceId.value, owner.value, repo.value, index.value, true);
  state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value, true);
}
</script>

<template>
  <div class="issue-detail">
    <div v-if="loading" class="loading-state">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error-state">
      <span>{{ t('dashboard.error', { message: error }) }}</span>
      <vscode-button icon="refresh" @click="reloadIssue" secondary>
        {{ t('dashboard.retry') }}
      </vscode-button>
    </div>
    <div v-else-if="detail" class="detail-content">
      <div class="detail-main">
        <div class="detail-header">
          <h2 class="detail-title">
            <span class="detail-number">#{{ detail.number }}</span>
            {{ detail.title }}
          </h2>
          <div class="header-actions">
            <span class="state-badge" :class="`state-${detail.state ?? 'open'}`">{{
              stateLabel(detail.state, t)
            }}</span>
            <vscode-button
              icon="link-external"
              :title="t('dashboard.detail.openIssue')"
              :aria-label="t('dashboard.detail.openIssue')"
              @click="state.openExternal(issueUrl)"
              icon-only
            />
            <vscode-button
              icon="copy"
              :title="t('dashboard.detail.copyLink')"
              :aria-label="t('dashboard.detail.copyLink')"
              @click="state.copyToClipboard(issueUrl)"
              icon-only
            />
            <vscode-button
              icon="git-branch"
              :title="t('dashboard.actions.startWork')"
              :aria-label="t('dashboard.actions.startWork')"
              :disabled="startWorkLoading"
              @click="handleStartWork"
              icon-only
            />
            <template v-if="canManageIssue">
              <vscode-button
                icon="edit"
                :title="t('dashboard.actions.edit')"
                :aria-label="t('dashboard.actions.edit')"
                @click="openEdit"
                icon-only
              />
              <vscode-button
                :icon="detail.state === 'open' ? 'close' : 'refresh'"
                :title="detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen')"
                :aria-label="detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen')"
                :disabled="stateToggleLoading"
                @click="toggleState"
                icon-only
              />
              <vscode-button
                icon="trash"
                :title="t('dashboard.actions.delete')"
                :aria-label="t('dashboard.actions.delete')"
                @click="handleDeleteIssue"
                icon-only
              />
            </template>
          </div>
        </div>

        <div v-if="stateToggleError" class="error state-toggle-error">
          {{ t('dashboard.error', { message: stateToggleError }) }}
        </div>
        <div v-if="startWorkError" class="error state-toggle-error">
          {{ t('dashboard.error', { message: startWorkError }) }}
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
          <span v-if="detail.closed_at" class="meta-item">
            {{ t('dashboard.detail.closedAt') }} {{ formatDate(detail.closed_at) }}
          </span>
        </div>

        <div class="detail-section">
          <h3>{{ t('dashboard.detail.body') }}</h3>
          <MarkdownBody
            :html="renderedBody"
            :loading="bodyLoading"
            :error="bodyError"
            :base-url="baseUrl"
            :instance-id="instanceId"
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
              :instance-id="instanceId"
              :owner="owner"
              :repo="repo"
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
              <vscode-button
                :disabled="!commentBody.trim() || commentLoading || uploadingCommentAttachmentCount > 0"
                @click="handleCommentSubmit"
              >
                {{
                  commentLoading || uploadingCommentAttachmentCount > 0
                    ? t('dashboard.form.saving')
                    : t('dashboard.detail.postComment')
                }}
              </vscode-button>
            </div>
            <div v-if="commentError" class="error">{{ t('dashboard.error', { message: commentError }) }}</div>
          </div>
        </div>
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
            <DateTimePicker v-model="dueDateValue" type="date" :disabled="dueDateSaving" />
            <div class="due-date-edit-actions">
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.save')"
                :disabled="dueDateSaving"
                @click="saveDueDate"
              >
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
                v-if="canManageIssue"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.edit')"
                @click="startEditDueDate"
              >
                <vscode-icon name="edit" />
              </button>
              <button
                v-if="canManageIssue"
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
                v-if="canManageIssue"
                type="button"
                class="link-button"
                :title="t('dashboard.actions.set')"
                @click="startEditDueDate"
              >
                <vscode-icon name="edit" />
              </button>
            </template>
          </div>
          <div v-if="dueDateError" class="error state-toggle-error">
            {{ t('dashboard.error', { message: dueDateError }) }}
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
            <span class="reference-text">{{ issueReference }}</span>
            <button
              type="button"
              class="link-button"
              :title="t('dashboard.actions.copyUrl')"
              @click="state.copyToClipboard(issueReference)"
            >
              <vscode-icon name="copy" />
            </button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.subscription')">
          <div v-if="subscription === undefined" class="loading-inline">{{ t('dashboard.loading') }}</div>
          <div v-else class="subscription-actions">
            <vscode-button
              :icon="subscription.subscribed ? 'bell-slash' : 'bell'"
              @click="toggleSubscription"
              secondary
            >
              {{ subscription.subscribed ? t('dashboard.detail.unsubscribe') : t('dashboard.detail.subscribe') }}
            </vscode-button>
          </div>
        </CollapsibleSection>

        <CollapsibleSection :title="t('dashboard.detail.timeTracking')">
          <div class="time-tracking-summary">
            <span class="tracked-time">{{
              formatDuration(trackedTimes.reduce((sum, t) => sum + (t.time ?? 0), 0))
            }}</span>
          </div>
          <div class="time-tracking-actions">
            <vscode-button
              v-if="!isStopwatchRunning"
              icon="play"
              @click="state.startIssueStopwatch(instanceId, owner, repo, index)"
              secondary
            >
              {{ t('dashboard.detail.startStopwatch') }}
            </vscode-button>
            <vscode-button
              v-else
              icon="debug-pause"
              @click="state.stopIssueStopwatch(instanceId, owner, repo, index)"
              secondary
            >
              {{ t('dashboard.detail.stopStopwatch') }}
            </vscode-button>
          </div>
          <div class="time-tracking-form">
            <vscode-textfield
              type="number"
              :value="String(manualTimeHours)"
              :min="0"
              @input="manualTimeHours = Number(($event.target as HTMLInputElement).value)"
            />
            <span>{{ t('dashboard.detail.hours') }}</span>
            <vscode-textfield
              type="number"
              :value="String(manualTimeMinutes)"
              :min="0"
              :max="59"
              @input="manualTimeMinutes = Number(($event.target as HTMLInputElement).value)"
            />
            <span>{{ t('dashboard.detail.minutes') }}</span>
            <vscode-button icon="add" @click="addManualTime" secondary>
              {{ t('dashboard.detail.addTime') }}
            </vscode-button>
          </div>
          <div v-if="trackedTimes.length" class="tracked-time-list">
            <div v-for="time in trackedTimes" :key="time.id" class="tracked-time-item">
              <span>{{ formatDuration(time.time ?? 0) }}</span>
              <span v-if="time.user_name" class="tracked-time-user">{{ time.user_name }}</span>
              <button
                type="button"
                class="link-button"
                :title="t('dashboard.actions.delete')"
                @click="handleDeleteTime(time.id ?? 0)"
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
                @click="handleRemoveDependency(dep.number)"
              >
                <vscode-icon name="trash" />
              </button>
            </div>
          </div>
          <div v-else class="empty-list">{{ t('dashboard.detail.noDependencies') }}</div>
          <div class="dependency-form">
            <div v-if="repoIssuesLoading" class="dependency-status">{{ t('dashboard.detail.dependencyLoading') }}</div>
            <template v-else>
              <vscode-single-select
                :value="selectedDependencyNumber === undefined ? '' : String(selectedDependencyNumber)"
                class="dependency-select"
                @change="selectedDependencyNumber = Number(($event.target as HTMLSelectElement).value) || undefined"
              >
                <vscode-option value="">{{ t('dashboard.detail.dependencyPlaceholder') }}</vscode-option>
                <vscode-option v-for="issue in availableDependencies" :key="issue.id" :value="String(issue.number)">
                  #{{ issue.number }} {{ issue.title }}
                </vscode-option>
              </vscode-single-select>
              <vscode-button
                icon="add"
                :disabled="!selectedDependencyNumber || availableDependencies.length === 0"
                @click="addDependency"
                secondary
              >
                {{ t('dashboard.detail.addDependency') }}
              </vscode-button>
            </template>
          </div>
          <div v-if="!repoIssuesLoading && availableDependencies.length === 0" class="dependency-status empty">
            {{ t('dashboard.detail.dependencyEmpty') }}
          </div>
        </CollapsibleSection>
      </div>

      <ModalDialog
        :open="isEditing"
        :title="t('dashboard.form.editIssue')"
        :loading="formLoading"
        :confirm-close-if-dirty="true"
        :is-dirty="editFormDirty"
        @close="closeEdit"
      >
        <IssueForm
          mode="edit"
          :initial-title="detail.title"
          :initial-body="detail.body"
          :initial-label-ids="
            (detail.labels ?? []).map((label) => label.id).filter((id): id is number => id !== undefined)
          "
          :initial-assignees="(detail.assignees ?? []).map((user) => user.login ?? '').filter(Boolean)"
          :initial-milestone-id="detail.milestone?.id"
          :initial-due-date="detail.due_date"
          :submit-label="t('dashboard.form.save')"
          :loading="formLoading"
          :error="editError"
          :labels="labels"
          :assignees="assignees"
          :milestones="milestones"
          :upload-image="handleUploadImage"
          :instance-id="instanceId"
          :owner="owner"
          :repo="repo"
          @submit="handleEditSubmit"
          @cancel="closeEdit"
          @dirty="editFormDirty = $event"
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
        </IssueForm>
      </ModalDialog>
    </div>
  </div>
</template>

<style scoped>
.issue-detail {
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

.state-toggle-error {
  color: var(--vscode-testing-iconFailed);
  font-size: 0.9em;
  margin-bottom: 8px;
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
  border-radius: 2px;
  font-size: 0.8em;
  font-weight: 600;
  text-transform: capitalize;
  background-color: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
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
</style>
