<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from 'vue-i18n';
import { VscodeButton } from '@cpf23333-forgejo-toolkit/vscode-elements-vue/components';
import MarkdownBody from '../components/MarkdownBody.vue';
import AttachmentList from '../components/AttachmentList.vue';
import PendingAttachmentList from '../components/PendingAttachmentList.vue';
import CommentTimeline from '../components/CommentTimeline.vue';
import ModalDialog from '../components/ModalDialog.vue';
import IssueForm from '../components/IssueForm.vue';
import EasyMdeEditor from '../components/EasyMdeEditor.vue';
import {
  useAppState,
  issueDetailKey,
  issueFormKey,
  issueCommentFormKey,
  pullRequestCommentsKey,
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
      <VscodeButton variant="secondary" icon="refresh" @click="reloadIssue">
        {{ t('dashboard.retry') }}
      </VscodeButton>
    </div>
    <div v-else-if="detail" class="detail-content">
      <div class="detail-header">
        <h2 class="detail-title">
          <span class="detail-number">#{{ detail.number }}</span>
          {{ detail.title }}
        </h2>
        <div class="header-actions">
          <span class="state-badge" :class="`state-${detail.state ?? 'open'}`">{{ detail.state }}</span>
          <VscodeButton
            variant="icon"
            icon="link-external"
            :title="t('dashboard.detail.openIssue')"
            :aria-label="t('dashboard.detail.openIssue')"
            @click="state.openExternal(issueUrl)"
          />
          <VscodeButton
            variant="icon"
            icon="copy"
            :title="t('dashboard.detail.copyLink')"
            :aria-label="t('dashboard.detail.copyLink')"
            @click="state.copyToClipboard(issueUrl)"
          />
          <template v-if="canManageIssue">
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
          <PendingAttachmentList :files="pendingCommentAttachments" @remove="removePendingCommentAttachment($event)" />
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

.detail-content {
  display: flex;
  flex-direction: column;
  gap: 16px;
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
  border-left: 3px solid var(--vscode-gitDecoration-untrackedResourceForeground, #28a745);
}

.state-closed {
  border-left: 3px solid var(--vscode-gitDecoration-deletedResourceForeground, #d73a49);
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
</style>
