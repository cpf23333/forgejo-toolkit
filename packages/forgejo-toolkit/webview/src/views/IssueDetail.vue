<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import MarkdownBody from '../components/MarkdownBody.vue';
import AttachmentList from '../components/AttachmentList.vue';
import CommentTimeline from '../components/CommentTimeline.vue';
import ModalDialog from '../components/ModalDialog.vue';
import IssueForm from '../components/IssueForm.vue';
import { useAppState, issueDetailKey, issueFormKey, pullRequestCommentsKey } from '../composables/useAppState';
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
const loading = computed(() => state.loading.value.get(key.value) ?? false);
const error = computed(() => state.errors.value.get(key.value));
const baseUrl = computed(() => state.instances.value.find((i) => i.id === instanceId.value)?.url);

const commentsKey = computed(() => pullRequestCommentsKey(instanceId.value, owner.value, repo.value, index.value));
const comments = computed(() => state.pullRequestComments.value.get(commentsKey.value) ?? []);
const commentsError = computed(() => state.errors.value.get(commentsKey.value));
const commentsLoading = computed(() => !state.pullRequestComments.value.has(commentsKey.value) && !commentsError.value);

watch(
  [instanceId, owner, repo, index],
  () => {
    state.loadIssueDetail(instanceId.value, owner.value, repo.value, index.value);
    state.loadPullRequestComments(instanceId.value, owner.value, repo.value, index.value);
  },
  { immediate: true },
);

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

const issueUrl = computed(() => detail.value?.html_url ?? '');
const isEditing = ref(false);
const uploadingAttachment = ref(false);
const deletingAttachmentId = ref<number | undefined>(undefined);
const isDeletingAttachments = ref(false);
const pendingDeleteAttachmentIds = ref<number[]>([]);
const editFormKey = computed(() => issueFormKey(instanceId.value, owner.value, repo.value, index.value));
const editLoading = computed(() => state.loading.value.get(editFormKey.value) ?? false);
const editError = computed(() => state.errors.value.get(editFormKey.value));
const formLoading = computed(() => editLoading.value || isDeletingAttachments.value);

function openEdit() {
  state.loadIssueDetail(instanceId.value, owner.value, repo.value, index.value);
  isEditing.value = true;
}

function closeEdit() {
  pendingDeleteAttachmentIds.value = [];
  isEditing.value = false;
}

function handleEditSubmit(title: string, body: string) {
  state.editIssue(instanceId.value, owner.value, repo.value, index.value, { title, body });
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
  uploadingAttachment.value = true;
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
    uploadingAttachment.value = false;
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
  state.editIssue(instanceId.value, owner.value, repo.value, index.value, { state: nextState });
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
        state.errors.value.set(editFormKey.value, t('dashboard.form.error', { message }));
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
</script>

<template>
  <div class="issue-detail">
    <div v-if="loading" class="loading">
      <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
    </div>
    <div v-else-if="error" class="error">{{ t('dashboard.error', { message: error }) }}</div>
    <div v-else-if="detail" class="detail-content">
      <div class="detail-header">
        <h2 class="detail-title">
          <span class="detail-number">#{{ detail.number }}</span>
          {{ detail.title }}
        </h2>
        <span class="state-badge" :class="`state-${detail.state ?? 'open'}`">{{ detail.state }}</span>
      </div>

      <div class="detail-meta">
        <img
          v-if="detail.user?.avatar_url"
          :src="detail.user.avatar_url"
          :alt="detail.user.login"
          class="user-avatar"
        />
        <span v-if="detail.user" class="user-name">{{ detail.user.login }}</span>
        <span v-if="detail.created_at" class="meta-item">{{ formatDate(detail.created_at) }}</span>
        <span v-if="detail.closed_at" class="meta-item">
          {{ t('dashboard.detail.closedAt') }} {{ formatDate(detail.closed_at) }}
        </span>
      </div>

      <div v-if="detail.labels?.length" class="detail-section">
        <h3>{{ t('dashboard.detail.labels') }}</h3>
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
      </div>

      <div v-if="detail.milestone" class="detail-section">
        <h3>{{ t('dashboard.detail.milestone') }}</h3>
        <span class="milestone-tag">{{ detail.milestone.title }}</span>
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
      </div>

      <AttachmentList :assets="detail.assets" @open-external="state.openExternal($event)" />

      <div class="detail-section">
        <h3>{{ t('dashboard.detail.commentsAndTimeline') }}</h3>
        <div v-if="commentsLoading" class="loading">
          <vscode-progress-ring class="detail-loading-ring" /> {{ t('dashboard.loading') }}
        </div>
        <div v-else-if="commentsError" class="error">{{ t('dashboard.error', { message: commentsError }) }}</div>
        <CommentTimeline v-else :comments="comments" :instance-id="instanceId" :base-url="baseUrl" />
      </div>

      <div class="actions">
        <a href="#" class="action-link" @click.prevent="state.openExternal(issueUrl)">
          {{ t('dashboard.detail.openIssue') }}
        </a>
        <a href="#" class="action-link" @click.prevent="state.copyToClipboard(issueUrl)">
          {{ t('dashboard.detail.copyLink') }}
        </a>
        <a href="#" class="action-link" @click.prevent="openEdit">
          {{ t('dashboard.actions.edit') }}
        </a>
        <a href="#" class="action-link" @click.prevent="toggleState">
          {{ detail.state === 'open' ? t('dashboard.actions.close') : t('dashboard.actions.reopen') }}
        </a>
      </div>

      <ModalDialog :open="isEditing" :title="t('dashboard.form.editIssue')" :loading="formLoading" @close="closeEdit">
        <IssueForm
          :initial-title="detail.title"
          :initial-body="detail.body"
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
              :uploading="uploadingAttachment"
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
}

.loading {
  color: var(--vscode-descriptionForeground);
}

.error {
  color: var(--vscode-testing-iconFailed);
}

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.detail-header {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
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

.state-badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.8em;
  font-weight: 600;
  text-transform: capitalize;
}

.state-open {
  background-color: var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
  color: #fff;
}

.state-closed {
  background-color: var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
  color: #fff;
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

.detail-loading-ring {
  width: 16px;
  height: 16px;
  vertical-align: middle;
}
</style>
